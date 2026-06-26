import { describe, it, expect } from "vitest";
import { nodeAtScreen } from "./hitTest";
import { IDENTITY } from "./camera";

const nodes = [
  { path: "a", x: 100, y: 100, r: 6 },
  { path: "b", x: 300, y: 100, r: 6 },
];

describe("hitTest", () => {
  it("노드 중심 근처를 맞춘다", () => {
    expect(nodeAtScreen(nodes, IDENTITY, 102, 101)).toBe("a");
  });
  it("빈 공간은 null", () => {
    expect(nodeAtScreen(nodes, IDENTITY, 200, 300)).toBeNull();
  });
  it("겹칠 때 더 가까운 노드", () => {
    expect(nodeAtScreen(nodes, IDENTITY, 290, 100)).toBe("b");
  });
  it("줌 상태에서도 화면 반경 기준으로 맞춘다", () => {
    const cam = { k: 2, tx: 0, ty: 0 }; // a 는 화면상 (200,200)
    expect(nodeAtScreen(nodes, cam, 204, 200)).toBe("a");
  });
});
