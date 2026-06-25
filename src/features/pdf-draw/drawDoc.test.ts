import { describe, it, expect } from "vitest";
import {
  emptyDrawDoc,
  isEmptyDoc,
  countShapes,
  newShapeId,
  serializeDrawDoc,
  parseDrawDoc,
  bakedPdfNameOf,
  distanceToSegment,
  shapeHitsPoint,
  eraseShapesAt,
  strokeToSvgPath,
  DRAW_DOC_VERSION,
  type DrawDoc,
  type PathShape,
} from "./drawDoc";

const pen = (points: number[], extra: Partial<PathShape> = {}): PathShape => ({
  id: "p1",
  type: "path",
  tool: "pen",
  color: "#e02424",
  width: 3,
  points,
  ...extra,
});

describe("DrawDoc 직렬화", () => {
  it("빈 문서를 만들고 비었음을 안다", () => {
    const d = emptyDrawDoc();
    expect(isEmptyDoc(d)).toBe(true);
    expect(countShapes(d)).toBe(0);
    expect(d.version).toBe(DRAW_DOC_VERSION);
  });

  it("라운드트립: 직렬화 후 파싱하면 동일 도형이 복원된다", () => {
    const doc: DrawDoc = {
      version: 2,
      pages: {
        1: [pen([10, 20, 30, 40])],
        3: [pen([1, 2, 3, 4], { id: "h1", tool: "highlighter" })],
      },
    };
    const restored = parseDrawDoc(serializeDrawDoc(doc));
    expect(countShapes(restored)).toBe(2);
    expect(restored.pages[1][0].points).toEqual([10, 20, 30, 40]);
    expect(restored.pages[1][0].id).toBe("p1");
    expect(restored.pages[3][0].tool).toBe("highlighter");
  });

  it("좌표를 소수 2자리로 반올림한다", () => {
    const doc: DrawDoc = { version: 2, pages: { 1: [pen([10.12345, 20.6789, 1, 2])] } };
    const json = serializeDrawDoc(doc);
    expect(json).toContain("10.12");
    expect(json).toContain("20.68");
    expect(json).not.toContain("10.12345");
  });

  it("빈 페이지(도형 0개)는 저장하지 않는다", () => {
    const doc: DrawDoc = { version: 2, pages: { 1: [], 2: [pen([0, 0, 1, 1])] } };
    const restored = parseDrawDoc(serializeDrawDoc(doc));
    expect(restored.pages[1]).toBeUndefined();
    expect(restored.pages[2]).toBeDefined();
  });

  it("손상된 JSON은 빈 문서로 복구한다", () => {
    expect(isEmptyDoc(parseDrawDoc("not json{"))).toBe(true);
    expect(isEmptyDoc(parseDrawDoc("null"))).toBe(true);
    expect(isEmptyDoc(parseDrawDoc("42"))).toBe(true);
  });

  it("부분 손상: 유효하지 않은 도형만 버리고 나머지는 살린다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: {
        1: [
          { id: "a", type: "path", tool: "pen", color: "#000", width: 2, points: [0, 0, 1, 1] }, // 유효
          { type: "bogus", color: "#000", width: 2, points: [0, 0] }, // 미지 타입
          { type: "path", tool: "pen", color: "#000", width: 2, points: [0] }, // 홀수 좌표
          { type: "path", tool: "pen", color: "#000", width: 2, points: [0, "x"] }, // 비수치
        ],
        "-1": [{ type: "path", tool: "pen", color: "#000", width: 2, points: [0, 0, 1, 1] }], // 잘못된 페이지
      },
    });
    const doc = parseDrawDoc(json);
    expect(countShapes(doc)).toBe(1);
    expect(doc.pages[1].length).toBe(1);
    expect(doc.pages[-1]).toBeUndefined();
  });

  it("미지 타입(상위 버전 도형)은 조용히 버린다", () => {
    const json = JSON.stringify({
      version: 99,
      pages: { 1: [{ id: "z", type: "hologram", foo: 1 }] },
    });
    expect(isEmptyDoc(parseDrawDoc(json))).toBe(true);
  });

  it("id 없는 도형엔 id 를 부여한다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: { 1: [{ type: "path", tool: "pen", color: "#000", width: 2, points: [0, 0, 1, 1] }] },
    });
    const doc = parseDrawDoc(json);
    expect(typeof doc.pages[1][0].id).toBe("string");
    expect(doc.pages[1][0].id.length).toBeGreaterThan(0);
  });

  it("newShapeId 는 매번 다른 비어있지 않은 문자열을 만든다", () => {
    const a = newShapeId();
    const b = newShapeId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("v1 → v2 마이그레이션", () => {
  it("타입 없는 v1 Stroke 를 path 도형으로 승격한다", () => {
    const v1 = JSON.stringify({
      version: 1,
      pages: {
        1: [{ tool: "pen", color: "#e02424", width: 3, points: [10, 20, 30, 40] }],
        2: [{ tool: "highlighter", color: "#16a34a", width: 6, points: [1, 1, 2, 2] }],
      },
    });
    const doc = parseDrawDoc(v1);
    expect(doc.version).toBe(2);
    expect(countShapes(doc)).toBe(2);
    const s = doc.pages[1][0];
    expect(s.type).toBe("path");
    expect(s.tool).toBe("pen");
    expect(s.points).toEqual([10, 20, 30, 40]);
    expect(typeof s.id).toBe("string");
    expect(doc.pages[2][0].tool).toBe("highlighter");
  });

  it("v1 문서를 다시 저장하면 v2 로 굳는다", () => {
    const v1 = JSON.stringify({
      version: 1,
      pages: { 1: [{ tool: "pen", color: "#000", width: 2, points: [0, 0, 1, 1] }] },
    });
    const json = serializeDrawDoc(parseDrawDoc(v1));
    expect(JSON.parse(json).version).toBe(2);
    expect(JSON.parse(json).pages[1][0].type).toBe("path");
  });
});

describe("경로 유도", () => {
  it("베이크 파일명은 (그림) 접미를 붙이고 확장자를 유지한다", () => {
    expect(bakedPdfNameOf("foo.pdf")).toBe("foo (그림).pdf");
    expect(bakedPdfNameOf("FOO.PDF")).toBe("FOO (그림).pdf");
    expect(bakedPdfNameOf("noext")).toBe("noext (그림).pdf");
  });
});

describe("지우개/선택 기하", () => {
  it("점-선분 거리: 수직 거리와 끝점 클램프", () => {
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(distanceToSegment(-3, 0, 0, 0, 10, 0)).toBeCloseTo(3); // 끝점 너머
    expect(distanceToSegment(0, 0, 0, 0, 0, 0)).toBe(0); // 퇴화
  });

  it("shapeHitsPoint(path): 굵기 절반 + radius 허용오차", () => {
    const s = pen([0, 0, 100, 0], { width: 4 }); // 반폭 2
    expect(shapeHitsPoint(s, 50, 0, 1)).toBe(true);
    expect(shapeHitsPoint(s, 50, 2.5, 1)).toBe(true); // 2(반폭)+1 = 3 안
    expect(shapeHitsPoint(s, 50, 10, 1)).toBe(false);
  });

  it("단일 점 도형도 히트테스트된다", () => {
    const dot = pen([10, 10], { width: 6 });
    expect(shapeHitsPoint(dot, 11, 11, 1)).toBe(true);
    expect(shapeHitsPoint(dot, 30, 30, 1)).toBe(false);
  });

  it("eraseShapesAt: 닿은 도형만 제거하고 원본은 불변", () => {
    const a = pen([0, 0, 10, 0], { id: "a" });
    const b = pen([0, 50, 10, 50], { id: "b" });
    const shapes = [a, b];
    const after = eraseShapesAt(shapes, 5, 0, 2);
    expect(after).toEqual([b]);
    expect(shapes.length).toBe(2); // 원본 불변
  });
});

describe("베이크 SVG path", () => {
  it("좌표열을 M/L 명령으로 변환한다", () => {
    expect(strokeToSvgPath([1, 2, 3, 4, 5, 6])).toBe("M 1 2 L 3 4 L 5 6");
  });

  it("단일 점은 미세 선분을 만들어 점이 찍히게 한다", () => {
    const d = strokeToSvgPath([10, 20]);
    expect(d.startsWith("M 10 20 L")).toBe(true);
  });

  it("좌표가 없으면 빈 문자열", () => {
    expect(strokeToSvgPath([])).toBe("");
  });
});
