import { describe, expect, it } from "vitest";
import { emptySceneJson, parseSceneContent } from "./scene";
import { SAMPLE_EXCALIDRAW_JSON, BLANK_EXCALIDRAW_JSON } from "./fixtures";

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

  // 이미지 자산(files)은 ExcalidrawEditor 에서 restore()→initialData.files 로
  // 복원되고 serializeAsJSON 으로 다시 저장된다. 그 앞단인 parseSceneContent 가
  // files 를 잃지 않는지(=라운드트립의 순수 검증 가능 부분)를 못 박는다. 실제
  // 픽셀 복원은 번들 의존이라 Ladle/E2E 에서 시각·동작으로 확인한다.
  it("임베드 이미지(files)를 가진 장면을 그대로 보존한다", () => {
    const result = parseSceneContent(SAMPLE_EXCALIDRAW_JSON);
    expect(result?.kind).toBe("scene");
    const data = (result as { kind: "scene"; data: Record<string, unknown> }).data;

    // image 요소가 fileId 로 자산을 참조한다
    const elements = data.elements as Array<Record<string, unknown>>;
    const image = elements.find((el) => el.type === "image");
    expect(image?.fileId).toBe("sample-img");

    // files 의 dataURL/mimeType 가 그대로 살아남는다 (재직렬화 라운드트립 포함)
    const files = data.files as Record<string, Record<string, unknown>>;
    expect(files["sample-img"]?.mimeType).toBe("image/png");
    expect(files["sample-img"]?.dataURL).toMatch(/^data:image\/png;base64,/);

    const roundtripped = parseSceneContent(JSON.stringify(data));
    expect(roundtripped).toEqual(result);
  });

  it("files 가 빈 장면도 받아들인다 (BLANK fixture)", () => {
    const result = parseSceneContent(BLANK_EXCALIDRAW_JSON);
    expect(result?.kind).toBe("scene");
    const data = (result as { kind: "scene"; data: Record<string, unknown> }).data;
    expect(data.elements).toEqual([]);
    expect(data.files).toEqual({});
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
