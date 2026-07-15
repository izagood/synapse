import { describe, expect, it } from "vitest";
import {
  adaptiveIterations,
  adjacencyOf,
  BH_THRESHOLD,
  estimateLabelWidth,
  layoutGraph,
  placeLabels,
  repulsionBH,
  repulsionExact,
  type GraphLayout,
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
      { path: `${ROOT}/a.md`, name: "a.md", kind: "note" as const },
      { path: `${ROOT}/b.md`, name: "b.md", kind: "note" as const },
      { path: `${ROOT}/c.md`, name: "c.md", kind: "note" as const },
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
        name: `n${i}.md`, kind: "note" as const,
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
      nodes: [{ path: `${ROOT}/a.md`, name: "a.md", kind: "note" as const }],
      edges: [{ source: `${ROOT}/a.md`, target: `${ROOT}/ghost.md` }],
    });
    expect(layout.edges).toHaveLength(0);
  });

  it("propagates node kind into positioned nodes", () => {
    const withTag: LinkGraph = {
      nodes: [
        { path: `${ROOT}/a.md`, name: "a.md", kind: "note" },
        { path: "#ai", name: "#ai", kind: "tag" },
      ],
      edges: [{ source: `${ROOT}/a.md`, target: "#ai" }],
    };
    const layout = layoutGraph(withTag);
    const byPath = new Map(layout.nodes.map((n) => [n.path, n.kind]));
    expect(byPath.get(`${ROOT}/a.md`)).toBe("note");
    expect(byPath.get("#ai")).toBe("tag");
  });
});

describe("layoutGraph — forces 파라미터", () => {
  const graph: LinkGraph = {
    nodes: [
      { path: `${ROOT}/a.md`, name: "a.md", kind: "note" as const },
      { path: `${ROOT}/b.md`, name: "b.md", kind: "note" as const },
      { path: `${ROOT}/c.md`, name: "c.md", kind: "note" as const },
    ],
    edges: [
      { source: `${ROOT}/a.md`, target: `${ROOT}/b.md` },
      { source: `${ROOT}/b.md`, target: `${ROOT}/c.md` },
    ],
  };

  const dist = (l: GraphLayout, a: string, b: string) => {
    const na = l.nodes.find((n) => n.path === a)!;
    const nb = l.nodes.find((n) => n.path === b)!;
    return Math.hypot(na.x - nb.x, na.y - nb.y);
  };

  it("같은 파라미터면 결정적", () => {
    const l1 = layoutGraph(graph, { repulsionScale: 2 });
    const l2 = layoutGraph(graph, { repulsionScale: 2 });
    expect(l1.nodes).toEqual(l2.nodes);
  });

  it("linkDistanceScale을 키우면 연결 노드 간 거리가 늘어난다", () => {
    const near = layoutGraph(graph, { linkDistanceScale: 0.25 });
    const far = layoutGraph(graph, { linkDistanceScale: 4 });
    expect(dist(far, `${ROOT}/a.md`, `${ROOT}/b.md`)).toBeGreaterThan(
      dist(near, `${ROOT}/a.md`, `${ROOT}/b.md`),
    );
  });

  it("기본값(1)은 파라미터 미지정과 동일 좌표", () => {
    expect(
      layoutGraph(graph, {
        repulsionScale: 1,
        linkDistanceScale: 1,
        gravityScale: 1,
      }).nodes,
    ).toEqual(layoutGraph(graph).nodes);
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
        { path: "/n/a.md", name: "a.md", kind: "note" as const },
        { path: "/n/b.md", name: "b.md", kind: "note" as const },
        { path: "/n/c.md", name: "c.md", kind: "note" as const },
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

// ── 성능 개선(P1~P3) 관련 ──────────────────────────────────────

/** n개 노드 + 앞쪽 일부만 사슬로 잇는 희소 그래프 생성 */
function sparseGraph(n: number, linked: number): LinkGraph {
  const nodes = Array.from({ length: n }, (_, i) => ({
    path: `${ROOT}/n${i}.md`,
    name: `n${i}.md`, kind: "note" as const,
  }));
  const edges = Array.from({ length: Math.max(0, linked - 1) }, (_, i) => ({
    source: `${ROOT}/n${i}.md`,
    target: `${ROOT}/n${i + 1}.md`,
  }));
  return { nodes, edges };
}

describe("layoutGraph — 고립 노드 분리(P1)", () => {
  it("모든 노드가 고립이어도 균일하게 배치된다", () => {
    const layout = layoutGraph(sparseGraph(50, 0), { width: 900, height: 600 });
    expect(layout.nodes).toHaveLength(50);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(900);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(600);
    }
    // 고립 노드끼리 같은 자리에 겹치지 않는다
    const seen = new Set(layout.nodes.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`));
    expect(seen.size).toBe(50);
  });

  it("고립 노드는 연결 구조보다 바깥(외곽 고리)에 놓인다", () => {
    const g = sparseGraph(200, 8); // 연결 8개 + 고립 192개
    const layout = layoutGraph(g, { width: 900, height: 600 });
    const dist = (n: { x: number; y: number }) =>
      Math.hypot((n.x - 450) / 450, (n.y - 300) / 300); // 타원 정규화 거리
    const linked = layout.nodes.filter((n) => n.degree > 0);
    const orphans = layout.nodes.filter((n) => n.degree === 0);
    const maxLinked = Math.max(...linked.map(dist));
    const minOrphan = Math.min(...orphans.map(dist));
    // 두 영역이 대체로 분리된다 (경계 살짝 겹침은 허용)
    expect(minOrphan).toBeGreaterThan(maxLinked * 0.6);
  });

  it("희소 그래프의 결정성: 같은 입력 → 같은 출력", () => {
    const g = sparseGraph(300, 20);
    const a = layoutGraph(g, { width: 900, height: 600 });
    const b = layoutGraph(g, { width: 900, height: 600 });
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });
});

describe("adaptiveIterations (P2)", () => {
  it("작은 그래프는 300회를 유지한다", () => {
    expect(adaptiveIterations(50)).toBe(300);
    expect(adaptiveIterations(300)).toBe(300);
  });

  it("커질수록 줄고 하한 80을 지킨다", () => {
    expect(adaptiveIterations(600)).toBeLessThan(300);
    expect(adaptiveIterations(600)).toBeGreaterThanOrEqual(80);
    expect(adaptiveIterations(100000)).toBe(80);
  });
});

describe("Barnes-Hut 반발 근사 (P3)", () => {
  /** 해시 기반 결정적 좌표 배열 생성 */
  function positions(m: number): { xs: Float64Array; ys: Float64Array } {
    const xs = new Float64Array(m);
    const ys = new Float64Array(m);
    for (let i = 0; i < m; i += 1) {
      xs[i] = 37 + ((i * 137) % 800) + (i % 7) * 0.13;
      ys[i] = 23 + ((i * 251) % 550) + (i % 5) * 0.29;
    }
    return { xs, ys };
  }

  it("θ=0이면 exact와 일치한다", () => {
    const m = 60;
    const { xs, ys } = positions(m);
    const ex = { x: new Float64Array(m), y: new Float64Array(m) };
    const bh = { x: new Float64Array(m), y: new Float64Array(m) };
    repulsionExact(xs, ys, m, 1000, ex.x, ex.y);
    repulsionBH(xs, ys, m, 1000, bh.x, bh.y, 0);
    for (let i = 0; i < m; i += 1) {
      expect(bh.x[i]).toBeCloseTo(ex.x[i], 6);
      expect(bh.y[i]).toBeCloseTo(ex.y[i], 6);
    }
  });

  it("기본 θ=0.9에서도 exact와 방향·크기가 대체로 일치한다", () => {
    const m = 200;
    const { xs, ys } = positions(m);
    const ex = { x: new Float64Array(m), y: new Float64Array(m) };
    const bh = { x: new Float64Array(m), y: new Float64Array(m) };
    repulsionExact(xs, ys, m, 1000, ex.x, ex.y);
    repulsionBH(xs, ys, m, 1000, bh.x, bh.y);
    let totalErr = 0;
    let totalMag = 0;
    for (let i = 0; i < m; i += 1) {
      totalErr += Math.hypot(bh.x[i] - ex.x[i], bh.y[i] - ex.y[i]);
      totalMag += Math.hypot(ex.x[i], ex.y[i]);
    }
    // 평균 상대 오차 10% 이내면 레이아웃 품질에 충분
    expect(totalErr / totalMag).toBeLessThan(0.1);
  });

  it("동일 좌표가 뭉쳐 있어도 발산하지 않는다", () => {
    const m = 8;
    const xs = new Float64Array(m).fill(100);
    const ys = new Float64Array(m).fill(100);
    const dx = new Float64Array(m);
    const dy = new Float64Array(m);
    repulsionBH(xs, ys, m, 1000, dx, dy);
    for (let i = 0; i < m; i += 1) {
      expect(Number.isFinite(dx[i])).toBe(true);
      expect(Number.isFinite(dy[i])).toBe(true);
    }
  });

  it("BH 경로를 타는 큰 그래프도 결정적이고 유한하다", () => {
    const linked = BH_THRESHOLD + 40;
    const g = sparseGraph(linked, linked); // 전부 연결 → sim 노드가 임계 초과
    const a = layoutGraph(g, { width: 900, height: 600, iterations: 30 });
    const b = layoutGraph(g, { width: 900, height: 600, iterations: 30 });
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    for (const node of a.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });
});
