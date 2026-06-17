import { describe, it, expect } from "vitest";
import {
  emptyDrawDoc,
  isEmptyDoc,
  countStrokes,
  serializeDrawDoc,
  parseDrawDoc,
  sidecarPathOf,
  bakedPdfNameOf,
  distanceToSegment,
  strokeHitsPoint,
  eraseStrokesAt,
  strokeToSvgPath,
  type DrawDoc,
  type Stroke,
} from "./drawDoc";

const pen = (points: number[], extra: Partial<Stroke> = {}): Stroke => ({
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
    expect(countStrokes(d)).toBe(0);
  });

  it("라운드트립: 직렬화 후 파싱하면 동일 획이 복원된다", () => {
    const doc: DrawDoc = {
      version: 1,
      pages: { 1: [pen([10, 20, 30, 40])], 3: [pen([1, 2, 3, 4], { tool: "highlighter" })] },
    };
    const restored = parseDrawDoc(serializeDrawDoc(doc));
    expect(countStrokes(restored)).toBe(2);
    expect(restored.pages[1][0].points).toEqual([10, 20, 30, 40]);
    expect(restored.pages[3][0].tool).toBe("highlighter");
  });

  it("좌표를 소수 2자리로 반올림한다", () => {
    const doc: DrawDoc = { version: 1, pages: { 1: [pen([10.12345, 20.6789, 1, 2])] } };
    const json = serializeDrawDoc(doc);
    expect(json).toContain("10.12");
    expect(json).toContain("20.68");
    expect(json).not.toContain("10.12345");
  });

  it("빈 페이지(획 0개)는 저장하지 않는다", () => {
    const doc: DrawDoc = { version: 1, pages: { 1: [], 2: [pen([0, 0, 1, 1])] } };
    const restored = parseDrawDoc(serializeDrawDoc(doc));
    expect(restored.pages[1]).toBeUndefined();
    expect(restored.pages[2]).toBeDefined();
  });

  it("손상된 JSON은 빈 문서로 복구한다", () => {
    expect(isEmptyDoc(parseDrawDoc("not json{"))).toBe(true);
    expect(isEmptyDoc(parseDrawDoc("null"))).toBe(true);
    expect(isEmptyDoc(parseDrawDoc("42"))).toBe(true);
  });

  it("부분 손상: 유효하지 않은 획만 버리고 나머지는 살린다", () => {
    const json = JSON.stringify({
      version: 1,
      pages: {
        1: [
          { tool: "pen", color: "#000", width: 2, points: [0, 0, 1, 1] }, // 유효
          { tool: "bogus", color: "#000", width: 2, points: [0, 0] }, // 잘못된 tool
          { tool: "pen", color: "#000", width: 2, points: [0] }, // 홀수 좌표
          { tool: "pen", color: "#000", width: 2, points: [0, "x"] }, // 비수치
        ],
        "-1": [{ tool: "pen", color: "#000", width: 2, points: [0, 0, 1, 1] }], // 잘못된 페이지
      },
    });
    const doc = parseDrawDoc(json);
    expect(countStrokes(doc)).toBe(1);
    expect(doc.pages[1].length).toBe(1);
    expect(doc.pages[-1]).toBeUndefined();
  });
});

describe("경로 유도", () => {
  it("사이드카 경로는 .draw.json 을 덧붙인다", () => {
    expect(sidecarPathOf("/a/b/foo.pdf")).toBe("/a/b/foo.pdf.draw.json");
    expect(sidecarPathOf("ssh://h/x/y.pdf")).toBe("ssh://h/x/y.pdf.draw.json");
  });

  it("베이크 파일명은 (그림) 접미를 붙이고 확장자를 유지한다", () => {
    expect(bakedPdfNameOf("foo.pdf")).toBe("foo (그림).pdf");
    expect(bakedPdfNameOf("FOO.PDF")).toBe("FOO (그림).pdf");
    expect(bakedPdfNameOf("noext")).toBe("noext (그림).pdf");
  });
});

describe("지우개 기하", () => {
  it("점-선분 거리: 수직 거리와 끝점 클램프", () => {
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(distanceToSegment(-3, 0, 0, 0, 10, 0)).toBeCloseTo(3); // 끝점 너머
    expect(distanceToSegment(0, 0, 0, 0, 0, 0)).toBe(0); // 퇴화
  });

  it("strokeHitsPoint: 굵기 절반 + radius 허용오차", () => {
    const s = pen([0, 0, 100, 0], { width: 4 }); // 반폭 2
    expect(strokeHitsPoint(s, 50, 0, 1)).toBe(true);
    expect(strokeHitsPoint(s, 50, 2.5, 1)).toBe(true); // 2(반폭)+1 = 3 안
    expect(strokeHitsPoint(s, 50, 10, 1)).toBe(false);
  });

  it("단일 점 획도 히트테스트된다", () => {
    const dot = pen([10, 10], { width: 6 });
    expect(strokeHitsPoint(dot, 11, 11, 1)).toBe(true);
    expect(strokeHitsPoint(dot, 30, 30, 1)).toBe(false);
  });

  it("eraseStrokesAt: 닿은 획만 제거하고 원본은 불변", () => {
    const a = pen([0, 0, 10, 0]);
    const b = pen([0, 50, 10, 50]);
    const strokes = [a, b];
    const after = eraseStrokesAt(strokes, 5, 0, 2);
    expect(after).toEqual([b]);
    expect(strokes.length).toBe(2); // 원본 불변
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
