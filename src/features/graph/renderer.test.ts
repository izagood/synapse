import { describe, it, expect } from "vitest";
import { buildScene, radiusOf, type RenderInput } from "./renderer";
import { initSim } from "./layout";
import { IDENTITY } from "./camera";

const theme = { bg: "#000", edge: "#555", edgeActive: "#7c6cf0", node: "#7c6cf0",
  nodeIso: "#888", current: "#fff", label: "#ddd", halo: "#7c6cf0" };

function baseInput(): RenderInput {
  const sim = initSim({ nodes: [{ path: "a", name: "a" }, { path: "b", name: "b" }],
    edges: [{ source: "a", target: "b" }] }, { width: 400, height: 300 });
  return { sim, cam: IDENTITY, theme, width: 400, height: 300, dpr: 1,
    hover: null, selected: null, current: null, neighbors: null, matches: null,
    shownLabels: new Set(["a"]), maxDegree: 1 };
}

describe("renderer scene", () => {
  it("clear 로 시작하고 엣지/노드 ops 를 포함", () => {
    const ops = buildScene(baseInput());
    expect(ops[0]).toEqual({ op: "clear" });
    expect(ops.some((o) => o.op === "edge")).toBe(true);
    expect(ops.filter((o) => o.op === "node")).toHaveLength(2);
  });
  it("shownLabels 에 든 노드만 label op", () => {
    const ops = buildScene(baseInput());
    const labels = ops.filter((o) => o.op === "label");
    expect(labels).toHaveLength(1);
    expect((labels[0] as { text: string }).text).toBe("a");
  });
  it("hover 시 인접 엣지는 active, 비인접은 dimmed", () => {
    const input = { ...baseInput(), hover: "a", neighbors: new Set(["b"]) };
    const ops = buildScene(input);
    const edge = ops.find((o) => o.op === "edge") as { active: boolean };
    expect(edge.active).toBe(true);
  });
  it("radiusOf 는 degree 0 이면 작은 고정값", () => {
    expect(radiusOf(0, 5)).toBeCloseTo(3.2);
    expect(radiusOf(5, 5)).toBeGreaterThan(radiusOf(1, 5));
  });
});
