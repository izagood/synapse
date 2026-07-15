import { afterEach, describe, expect, it } from "vitest";
import type { LinkGraph } from "../../ipc/types";
import { layoutGraph } from "./layout";
import {
  clearLayoutCache,
  getCachedLayout,
  graphSignature,
  setCachedLayout,
} from "./layoutCache";

const g = (paths: string[], edges: [string, string][] = []): LinkGraph => ({
  nodes: paths.map((p) => ({
    path: p,
    name: p.split("/").pop() ?? p,
    kind: "note" as const,
  })),
  edges: edges.map(([source, target]) => ({ source, target })),
});

afterEach(() => clearLayoutCache());

describe("graphSignature", () => {
  it("같은 그래프 → 같은 서명", () => {
    const a = g(["/n/a.md", "/n/b.md"], [["/n/a.md", "/n/b.md"]]);
    const b = g(["/n/a.md", "/n/b.md"], [["/n/a.md", "/n/b.md"]]);
    expect(graphSignature(a)).toBe(graphSignature(b));
  });

  it("노드가 다르면 서명이 다르다", () => {
    expect(graphSignature(g(["/n/a.md"]))).not.toBe(graphSignature(g(["/n/b.md"])));
  });

  it("엣지가 다르면 서명이 다르다", () => {
    const base = g(["/n/a.md", "/n/b.md"]);
    const linked = g(["/n/a.md", "/n/b.md"], [["/n/a.md", "/n/b.md"]]);
    expect(graphSignature(base)).not.toBe(graphSignature(linked));
  });

  it("필드 경계가 다른 경로 조합을 구분한다", () => {
    // 구분자 없이 이어붙이면 같은 바이트열이 되는 케이스
    expect(graphSignature(g(["/n/ab", "/n/c"]))).not.toBe(
      graphSignature(g(["/n/a", "/n/bc"])),
    );
  });
});

describe("layout 캐시", () => {
  it("같은 서명이면 캐시된 레이아웃 객체를 그대로 돌려준다", () => {
    const graph = g(["/n/a.md", "/n/b.md"], [["/n/a.md", "/n/b.md"]]);
    const sig = graphSignature(graph);
    expect(getCachedLayout(sig)).toBeNull();

    const layout = layoutGraph(graph, { width: 900, height: 600 });
    setCachedLayout(sig, layout);
    expect(getCachedLayout(sig)).toBe(layout); // 재계산 없이 동일 참조

    expect(getCachedLayout("다른서명")).toBeNull();
  });

  it("새 서명을 저장하면 이전 항목은 밀려난다 (1건 캐시)", () => {
    const g1 = g(["/n/a.md"]);
    const g2 = g(["/n/b.md"]);
    const s1 = graphSignature(g1);
    const s2 = graphSignature(g2);
    setCachedLayout(s1, layoutGraph(g1));
    setCachedLayout(s2, layoutGraph(g2));
    expect(getCachedLayout(s1)).toBeNull();
    expect(getCachedLayout(s2)).not.toBeNull();
  });
});
