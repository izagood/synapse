import { describe, expect, it } from "vitest";
import type { LinkGraph } from "../../ipc/types";
import { buildTagIndex, filterGraph, groupColorOf } from "./filter";

const g: LinkGraph = {
  nodes: [
    { path: "/w/a.md", name: "a.md", kind: "note" },
    { path: "/w/b.md", name: "b.md", kind: "note" },
    { path: "/w/sub/c.md", name: "c.md", kind: "note" },
    { path: "/w/orphan.md", name: "orphan.md", kind: "note" },
    { path: "#ai", name: "#ai", kind: "tag" },
  ],
  edges: [
    { source: "/w/a.md", target: "/w/b.md" },
    { source: "/w/b.md", target: "/w/sub/c.md" },
    { source: "/w/a.md", target: "#ai" },
  ],
};

describe("filterGraph", () => {
  it("showTags=false면 태그 노드·그 엣지를 제거한다", () => {
    const f = filterGraph(g, { query: "", showTags: false, showOrphans: true });
    expect(f.nodes.some((n) => n.kind === "tag")).toBe(false);
    expect(f.edges.some((e) => e.target === "#ai")).toBe(false);
    // 노트 링크 엣지는 그대로
    expect(f.edges).toHaveLength(2);
  });

  it("showOrphans=false면 필터 후 degree 0 노트를 제거한다", () => {
    const f = filterGraph(g, { query: "", showTags: true, showOrphans: false });
    expect(f.nodes.map((n) => n.path)).not.toContain("/w/orphan.md");
    expect(f.nodes.map((n) => n.path)).toContain("/w/a.md");
  });

  it("태그를 껐을 때 태그로만 연결되던 노트도 고립으로 숨긴다", () => {
    const withTagOnly: LinkGraph = {
      nodes: [
        { path: "/w/x.md", name: "x.md", kind: "note" },
        { path: "#solo", name: "#solo", kind: "tag" },
      ],
      edges: [{ source: "/w/x.md", target: "#solo" }],
    };
    const f = filterGraph(withTagOnly, {
      query: "",
      showTags: false,
      showOrphans: false,
    });
    expect(f.nodes).toEqual([]);
  });

  it("query는 이름 부분 일치 노드 + 그 이웃만 남긴다", () => {
    const f = filterGraph(g, { query: "a.md", showTags: true, showOrphans: true });
    const paths = f.nodes.map((n) => n.path);
    expect(paths).toContain("/w/a.md");
    expect(paths).toContain("/w/b.md"); // a의 이웃
    expect(paths).not.toContain("/w/sub/c.md"); // 2단계 밖
    expect(paths).not.toContain("/w/orphan.md");
  });

  it("local: center에서 depth 1이면 직접 이웃까지만", () => {
    const f = filterGraph(g, {
      query: "",
      showTags: true,
      showOrphans: true,
      local: { center: "/w/a.md", depth: 1 },
    });
    expect(f.nodes.map((n) => n.path).sort()).toEqual([
      "#ai",
      "/w/a.md",
      "/w/b.md",
    ]);
  });

  it("local depth 2면 이웃의 이웃까지", () => {
    const f = filterGraph(g, {
      query: "",
      showTags: true,
      showOrphans: true,
      local: { center: "/w/a.md", depth: 2 },
    });
    expect(f.nodes.map((n) => n.path)).toContain("/w/sub/c.md");
  });
});

describe("groupColorOf", () => {
  const tagIndex = buildTagIndex(g);

  it("tag: 규칙은 해당 태그를 가진 노트와 태그 노드 자신에 일치", () => {
    const groups = [{ id: "1", query: "tag:ai", color: "#ff0000" }];
    expect(groupColorOf(g.nodes[0], groups, tagIndex)).toBe("#ff0000"); // a.md는 #ai 보유
    expect(groupColorOf(g.nodes[4], groups, tagIndex)).toBe("#ff0000"); // #ai 노드 자신
    expect(groupColorOf(g.nodes[1], groups, tagIndex)).toBeNull();
  });

  it("tag:#x 처럼 #을 붙여 써도 같다", () => {
    const groups = [{ id: "1", query: "tag:#AI", color: "#ff0000" }];
    expect(groupColorOf(g.nodes[0], groups, tagIndex)).toBe("#ff0000");
  });

  it("path: 규칙은 경로 부분 일치, 일반 문자열은 이름 부분 일치, 첫 일치 우선", () => {
    const groups = [
      { id: "1", query: "path:sub/", color: "#00ff00" },
      { id: "2", query: "c.md", color: "#0000ff" },
    ];
    expect(groupColorOf(g.nodes[2], groups, tagIndex)).toBe("#00ff00"); // path 규칙이 먼저
    expect(groupColorOf(g.nodes[0], groups, tagIndex)).toBeNull();
  });

  it("빈 쿼리 그룹은 건너뛴다", () => {
    const groups = [
      { id: "1", query: "  ", color: "#00ff00" },
      { id: "2", query: "a.md", color: "#0000ff" },
    ];
    expect(groupColorOf(g.nodes[0], groups, tagIndex)).toBe("#0000ff");
  });
});
