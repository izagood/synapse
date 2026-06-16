import { describe, expect, it } from "vitest";
import { emptySceneJson, parseSceneContent } from "./scene";

describe("parseSceneContent", () => {
  it("빈/공백 내용은 빈(새) 드로잉", () => {
    expect(parseSceneContent("")).toEqual({ kind: "empty" });
    expect(parseSceneContent("   \n ")).toEqual({ kind: "empty" });
  });

  it("정상 장면은 파싱된 원본 데이터를 그대로 넘긴다 (정규화는 restore가 담당)", () => {
    const scene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "a", type: "rectangle" }],
      appState: { viewBackgroundColor: "#fff" },
      files: {},
    };
    const result = parseSceneContent(JSON.stringify(scene));
    expect(result).toEqual({ kind: "scene", data: scene });
  });

  it("깨진 JSON은 null (원본 보호)", () => {
    expect(parseSceneContent("{not json")).toBeNull();
  });

  it("elements 배열이 없으면 null (다른 JSON 파일 보호)", () => {
    expect(parseSceneContent(JSON.stringify({ type: "excalidraw" }))).toBeNull();
    expect(parseSceneContent(JSON.stringify({ elements: "x" }))).toBeNull();
    expect(parseSceneContent(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseSceneContent("42")).toBeNull();
  });
});

describe("emptySceneJson", () => {
  it("parseSceneContent가 받아들이는 빈 Excalidraw 장면을 만든다", () => {
    const json = emptySceneJson();
    const data = JSON.parse(json);
    expect(data.type).toBe("excalidraw");
    expect(data.version).toBe(2);
    expect(data.elements).toEqual([]);
    expect(parseSceneContent(json)).toEqual({ kind: "scene", data });
  });
});
