import { describe, expect, it } from "vitest";
import {
  adjacencyOf,
  estimateLabelWidth,
  layoutGraph,
  placeLabels,
  type LabelCandidate,
} from "./layout";
import { computeGraph } from "../editor/backlinks";
import type { LinkGraph } from "../../ipc/types";

const ROOT = "/notes";

describe("computeGraph", () => {
  it("builds nodes and directed edges from standard + wiki links", () => {
    const files = new Map<string, string>([
      [`${ROOT}/a.md`, "표준 [b](b.md) 와 위키 [[c]]"],
      [`${ROOT}/b.md`, "[[c]] 만"],
      [`${ROOT}/c.md`, "# 대상"],
      // 비-마크다운·다른 루트는 무시
      [`${ROOT}/img.png`, "binary"],
      ["/other/x.md", "[a](../notes/a.md)"],
    ]);
    const g = computeGraph(ROOT, files);
    expect(g.nodes.map((n) => n.name)).toEqual(["a.md", "b.md", "c.md"]);
    const pairs = g.edges.map((e) => [
      e.source.split("/").pop(),
      e.target.split("/").pop(),
    ]);
    expect(pairs).toContainEqual(["a.md", "b.md"]);
    expect(pairs).toContainEqual(["a.md", "c.md"]);
    expect(pairs).toContainEqual(["b.md", "c.md"]);
    expect(g.edges).toHaveLength(3);
  });

  it("excludes self-links, external URLs, escaping paths, and dedups", () => {
    const files = new Map<string, string>([
      [
        `${ROOT}/a.md`,
        "[self](a.md) [ext](https://x.com) [up](../out.md) [b](b.md) 또 [b2](b.md)",
      ],
      [`${ROOT}/b.md`, "내용"],
    ]);
    const g = computeGraph(ROOT, files);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].source.endsWith("a.md")).toBe(true);
    expect(g.edges[0].target.endsWith("b.md")).toBe(true);
  });

  it("ignores edges to non-existent notes", () => {
    const files = new Map<string, string>([
      [`${ROOT}/a.md`, "[missing](nope.md) and [[also-missing]]"],
    ]);
    const g = computeGraph(ROOT, files);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
});

describe("layoutGraph", () => {
  const graph: LinkGraph = {
    nodes: [
      { path: `${ROOT}/a.md`, name: "a.md" },
      { path: `${ROOT}/b.md`, name: "b.md" },
      { path: `${ROOT}/c.md`, name: "c.md" },
    ],
    edges: [
      { source: `${ROOT}/a.md`, target: `${ROOT}/b.md` },
      { source: `${ROOT}/a.md`, target: `${ROOT}/c.md` },
    ],
  };

  it("positions every node within bounds", () => {
    const layout = layoutGraph(graph, { width: 400, height: 300 });
    expect(layout.nodes).toHaveLength(3);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(400);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(300);
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("computes degree (in + out) per node", () => {
    const layout = layoutGraph(graph);
    const byName = new Map(layout.nodes.map((n) => [n.name, n.degree]));
    expect(byName.get("a.md")).toBe(2); // a→b, a→c
    expect(byName.get("b.md")).toBe(1);
    expect(byName.get("c.md")).toBe(1);
  });

  it("is deterministic for the same input", () => {
    const a = layoutGraph(graph, { width: 400, height: 300 });
    const b = layoutGraph(graph, { width: 400, height: 300 });
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(
      b.nodes.map((n) => [n.x, n.y]),
    );
  });

  it("does not pile nodes onto a rectangular boundary", () => {
    // 노드가 많아 반발력이 강해도, 반복별 사각 클램프가 없으므로
    // 경계선 위에 노드가 일렬로 들러붙지 않아야 한다(fit-to-viewport).
    const many: LinkGraph = {
      nodes: Array.from({ length: 60 }, (_, i) => ({
        path: `${ROOT}/n${i}.md`,
        name: `n${i}.md`,
      })),
      edges: Array.from({ length: 30 }, (_, i) => ({
        source: `${ROOT}/n${i}.md`,
        target: `${ROOT}/n${(i + 1) % 60}.md`,
      })),
    };
    const layout = layoutGraph(many, { width: 400, height: 300 });
    // 과거 클램프 경계(pad=24)에 정확히 붙은 노드가 없어야 한다.
    const onWall = layout.nodes.filter(
      (n) => n.x === 24 || n.x === 376 || n.y === 24 || n.y === 276,
    );
    expect(onWall).toHaveLength(0);
    // fit 패딩(40) 안쪽에 모두 담겨야 한다.
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(39.9);
      expect(n.x).toBeLessThanOrEqual(360.1);
      expect(n.y).toBeGreaterThanOrEqual(39.9);
      expect(n.y).toBeLessThanOrEqual(260.1);
    }
  });

  it("handles an empty graph", () => {
    const layout = layoutGraph({ nodes: [], edges: [] });
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
  });

  it("drops edges that reference missing nodes", () => {
    const layout = layoutGraph({
      nodes: [{ path: `${ROOT}/a.md`, name: "a.md" }],
      edges: [{ source: `${ROOT}/a.md`, target: `${ROOT}/ghost.md` }],
    });
    expect(layout.edges).toHaveLength(0);
  });
});

describe("estimateLabelWidth", () => {
  it("grows with text length", () => {
    expect(estimateLabelWidth("abcd")).toBeGreaterThan(estimateLabelWidth("ab"));
  });

  it("counts CJK characters wider than latin ones", () => {
    // 같은 글자 수라도 한글이 더 넓게 추정돼야 한다.
    expect(estimateLabelWidth("가나다")).toBeGreaterThan(
      estimateLabelWidth("abc"),
    );
  });

  it("returns 0 for an empty string", () => {
    expect(estimateLabelWidth("")).toBe(0);
  });
});

describe("placeLabels", () => {
  const at = (
    path: string,
    x: number,
    y: number,
    extra: Partial<LabelCandidate> = {},
  ): LabelCandidate => ({ path, x, y, r: 5, width: 40, priority: 0, ...extra });

  it("shows labels that are far apart", () => {
    const shown = placeLabels([at("a", 0, 0), at("b", 0, 200)]);
    expect(shown).toEqual(new Set(["a", "b"]));
  });

  it("hides the lower-priority label when two overlap", () => {
    const shown = placeLabels([
      at("a", 0, 0, { priority: 1 }),
      at("b", 1, 1, { priority: 5 }),
    ]);
    expect(shown).toEqual(new Set(["b"])); // b가 우선순위 높아 자리 차지
  });

  it("always shows forced labels even when overlapping", () => {
    const shown = placeLabels([
      at("a", 0, 0, { priority: 9 }),
      at("b", 1, 1, { force: true, priority: 0 }),
    ]);
    expect(shown.has("b")).toBe(true);
    // force 라벨이 자리를 차지하므로 겹치는 일반 라벨은 숨는다.
    expect(shown.has("a")).toBe(false);
  });

  it("is deterministic regardless of input order", () => {
    const a = at("a", 0, 0, { priority: 3 });
    const b = at("b", 1, 1, { priority: 3 });
    expect(placeLabels([a, b])).toEqual(placeLabels([b, a]));
  });
});

describe("adjacencyOf", () => {
  it("returns neighbors regardless of direction", () => {
    const graph: LinkGraph = {
      nodes: [
        { path: "/n/a.md", name: "a.md" },
        { path: "/n/b.md", name: "b.md" },
        { path: "/n/c.md", name: "c.md" },
      ],
      edges: [
        { source: "/n/a.md", target: "/n/b.md" },
        { source: "/n/c.md", target: "/n/a.md" },
      ],
    };
    expect(adjacencyOf(graph, "/n/a.md")).toEqual(new Set(["/n/b.md", "/n/c.md"]));
    expect(adjacencyOf(graph, "/n/b.md")).toEqual(new Set(["/n/a.md"]));
  });
});
