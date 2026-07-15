import { describe, expect, it } from "vitest";
import { mockIpc } from "./mock";

describe("mock linkGraph 태그", () => {
  it("본문 #태그를 tag 노드로 승격한다", async () => {
    const g = await mockIpc.linkGraph("/mock/notes");
    const tags = g.nodes.filter((n) => n.kind === "tag");
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((n) => n.path.startsWith("#"))).toBe(true);
    // 모든 노드는 kind가 명시돼 있다
    expect(g.nodes.every((n) => n.kind === "tag" || n.kind === "note")).toBe(true);
  });
});
