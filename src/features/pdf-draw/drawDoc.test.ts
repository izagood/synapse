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
  smoothPath,
  effectiveOpacity,
  isNonEmptyShape,
  shapeBounds,
  translateShape,
  scaleShape,
  topmostShapeAt,
  textSize,
  imageAssetPrefixOf,
  DRAW_DOC_VERSION,
  type DrawDoc,
  type PathShape,
  type LineShape,
  type RectLikeShape,
  type TextShape,
  type ImageShape,
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
    expect((restored.pages[1][0] as PathShape).points).toEqual([10, 20, 30, 40]);
    expect(restored.pages[1][0].id).toBe("p1");
    expect((restored.pages[3][0] as PathShape).tool).toBe("highlighter");
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
    const s = doc.pages[1][0] as PathShape;
    expect(s.type).toBe("path");
    expect(s.tool).toBe("pen");
    expect(s.points).toEqual([10, 20, 30, 40]);
    expect(typeof s.id).toBe("string");
    expect((doc.pages[2][0] as PathShape).tool).toBe("highlighter");
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

describe("곡선 스무딩 / SVG path", () => {
  it("3점 이상은 2차 베지어(Q)로 변환한다(중점 기법)", () => {
    // 내부 점은 제어점, 인접 중점이 끝점. 마지막은 끝점으로 마무리.
    expect(strokeToSvgPath([1, 2, 3, 4, 5, 6])).toBe("M 1 2 Q 3 4 4 5 Q 5 6 5 6");
  });

  it("두 점은 직선(제어점=시작점)", () => {
    expect(strokeToSvgPath([1, 2, 3, 4])).toBe("M 1 2 Q 1 2 3 4");
  });

  it("단일 점은 미세 구간을 만들어 점이 찍히게 한다", () => {
    expect(strokeToSvgPath([10, 20]).startsWith("M 10 20 Q")).toBe(true);
  });

  it("좌표가 없으면 빈 문자열", () => {
    expect(strokeToSvgPath([])).toBe("");
  });

  it("smoothPath: 점이 없으면 null", () => {
    expect(smoothPath([])).toBeNull();
  });

  it("smoothPath: 화면(canvas)·베이크가 같은 시작점/구간을 공유한다", () => {
    const sp = smoothPath([0, 0, 10, 0, 20, 0]);
    expect(sp).not.toBeNull();
    expect(sp?.startX).toBe(0);
    expect(sp?.startY).toBe(0);
    expect((sp?.segs.length ?? 0) >= 2).toBe(true);
  });
});

describe("도형(line/arrow/rect/ellipse)", () => {
  const line = (a: [number, number], b: [number, number], extra: Partial<LineShape> = {}): LineShape => ({
    id: "l1",
    type: "line",
    color: "#000",
    width: 2,
    a,
    b,
    ...extra,
  });
  const rect = (r: [number, number, number, number], extra: Partial<RectLikeShape> = {}): RectLikeShape => ({
    id: "r1",
    type: "rect",
    stroke: "#000",
    width: 2,
    rect: r,
    ...extra,
  });

  it("line/arrow 를 직렬화·복원한다(opacity 포함)", () => {
    const doc: DrawDoc = {
      version: 2,
      pages: {
        1: [line([0, 0], [10, 10]), line([1, 1], [5, 5], { id: "a1", type: "arrow", opacity: 0.5 })],
      },
    };
    const r = parseDrawDoc(serializeDrawDoc(doc));
    expect(countShapes(r)).toBe(2);
    expect(r.pages[1][0].type).toBe("line");
    expect((r.pages[1][0] as LineShape).b).toEqual([10, 10]);
    expect(r.pages[1][1].type).toBe("arrow");
    expect(r.pages[1][1].opacity).toBe(0.5);
  });

  it("rect/ellipse 를 직렬화·복원한다(stroke/fill/radius)", () => {
    const doc: DrawDoc = {
      version: 2,
      pages: {
        1: [
          rect([0, 0, 10, 20], { fill: "#eee", radius: 4 }),
          rect([5, 5, 30, 30], { id: "e1", type: "ellipse", stroke: "#00f", width: 1 }),
        ],
      },
    };
    const r = parseDrawDoc(serializeDrawDoc(doc));
    expect(countShapes(r)).toBe(2);
    const got = r.pages[1][0] as RectLikeShape;
    expect(got.type).toBe("rect");
    expect(got.fill).toBe("#eee");
    expect(got.radius).toBe(4);
    expect(got.rect).toEqual([0, 0, 10, 20]);
    expect(r.pages[1][1].type).toBe("ellipse");
  });

  it("stroke·fill 둘 다 없는 rect 는 보이지 않으므로 버린다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: { 1: [{ id: "x", type: "rect", width: 2, rect: [0, 0, 5, 5] }] },
    });
    expect(isEmptyDoc(parseDrawDoc(json))).toBe(true);
  });

  it("좌표가 불완전한 도형은 버린다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: {
        1: [
          { id: "l", type: "line", color: "#000", width: 2, a: [0, 0] }, // b 없음
          { id: "r", type: "rect", stroke: "#000", width: 2, rect: [0, 0, 5] }, // rect 길이 3
        ],
      },
    });
    expect(isEmptyDoc(parseDrawDoc(json))).toBe(true);
  });

  it("isNonEmptyShape: 길이 0 line·0 크기 rect 는 빈 것", () => {
    expect(isNonEmptyShape(line([3, 3], [3, 3]))).toBe(false);
    expect(isNonEmptyShape(rect([0, 0, 0, 0]))).toBe(false);
    expect(isNonEmptyShape(rect([0, 0, 5, 0]))).toBe(true); // 한 변이라도 있으면
  });

  it("shapeHitsPoint(line): 선분 근처만 히트", () => {
    const l = line([0, 0], [100, 0]);
    expect(shapeHitsPoint(l, 50, 0, 1)).toBe(true);
    expect(shapeHitsPoint(l, 50, 20, 1)).toBe(false);
  });

  it("shapeHitsPoint(rect): 채우면 내부도, 테두리만이면 내부 비히트", () => {
    const filled = rect([0, 0, 100, 100], { fill: "#eee" });
    expect(shapeHitsPoint(filled, 50, 50, 1)).toBe(true);
    const bordered = rect([0, 0, 100, 100]);
    expect(shapeHitsPoint(bordered, 50, 50, 1)).toBe(false);
    expect(shapeHitsPoint(bordered, 0, 50, 1)).toBe(true); // 왼쪽 테두리
  });

  it("shapeHitsPoint(ellipse): 채운 타원 내부 히트", () => {
    const e = rect([0, 0, 100, 50], { id: "e", type: "ellipse", fill: "#eee" });
    expect(shapeHitsPoint(e, 50, 25, 1)).toBe(true); // 중심
    expect(shapeHitsPoint(e, 2, 2, 1)).toBe(false); // 모서리(타원 밖)
  });
});

describe("선택/편집 기하", () => {
  const ln = (a: [number, number], b: [number, number]): LineShape => ({
    id: "l",
    type: "line",
    color: "#000",
    width: 2,
    a,
    b,
  });
  const rc = (
    r: [number, number, number, number],
    extra: Partial<RectLikeShape> = {},
  ): RectLikeShape => ({ id: "r", type: "rect", stroke: "#000", width: 2, rect: r, ...extra });

  it("shapeBounds: path/line/rect 의 bbox", () => {
    expect(shapeBounds(pen([0, 0, 10, 20]))).toEqual([0, 0, 10, 20]);
    expect(shapeBounds(ln([2, 3], [8, 1]))).toEqual([2, 1, 6, 2]);
    expect(shapeBounds(rc([5, 5, 30, 40]))).toEqual([5, 5, 30, 40]);
  });

  it("translateShape: 모든 좌표를 평행이동", () => {
    expect((translateShape(pen([0, 0, 10, 10]), 5, 3) as PathShape).points).toEqual([5, 3, 15, 13]);
    const l = translateShape(ln([0, 0], [10, 10]), 1, 2) as LineShape;
    expect(l.a).toEqual([1, 2]);
    expect(l.b).toEqual([11, 12]);
    expect((translateShape(rc([0, 0, 5, 5]), 2, 2) as RectLikeShape).rect).toEqual([2, 2, 5, 5]);
  });

  it("scaleShape: bbox old→new 로 선형 매핑(2배)", () => {
    const r = scaleShape(rc([0, 0, 10, 10]), [0, 0, 10, 10], [0, 0, 20, 20]) as RectLikeShape;
    expect(r.rect).toEqual([0, 0, 20, 20]);
    const r2 = scaleShape(rc([10, 10, 10, 10]), [0, 0, 20, 20], [0, 0, 40, 40]) as RectLikeShape;
    expect(r2.rect).toEqual([20, 20, 20, 20]);
  });

  it("scaleShape: 변이 0인 축은 평행이동만(0 나눗셈 방지)", () => {
    // 가로선 path: bounds 높이 0
    const horiz = pen([0, 5, 10, 5]);
    const out = scaleShape(horiz, [0, 5, 10, 0], [0, 9, 20, 0]) as PathShape;
    expect(out.points).toEqual([0, 9, 20, 9]); // x 2배, y 평행이동
  });

  it("topmostShapeAt: z-순서 역순(맨 위 우선)", () => {
    const a = rc([0, 0, 100, 100], { id: "a", fill: "#eee" });
    const b = rc([0, 0, 100, 100], { id: "b", fill: "#ddd" });
    expect(topmostShapeAt([a, b], 50, 50, 1)).toBe("b"); // 나중에 그린 b 가 위
    expect(topmostShapeAt([a, b], 500, 500, 1)).toBeNull();
  });
});

describe("텍스트(text)", () => {
  const txt = (extra: Partial<TextShape> = {}): TextShape => ({
    id: "t1",
    type: "text",
    text: "가나다",
    color: "#000",
    fontSize: 16,
    pos: [10, 20],
    ...extra,
  });

  it("직렬화·복원(한글 포함, opacity)", () => {
    const doc: DrawDoc = { version: 2, pages: { 1: [txt({ text: "한글 abc", opacity: 0.7 })] } };
    const t = parseDrawDoc(serializeDrawDoc(doc)).pages[1][0] as TextShape;
    expect(t.type).toBe("text");
    expect(t.text).toBe("한글 abc");
    expect(t.fontSize).toBe(16);
    expect(t.opacity).toBe(0.7);
    expect(t.pos).toEqual([10, 20]);
  });

  it("빈 텍스트(내용 없음)는 버린다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: { 1: [{ id: "x", type: "text", text: "", color: "#000", fontSize: 16, pos: [0, 0] }] },
    });
    expect(isEmptyDoc(parseDrawDoc(json))).toBe(true);
  });

  it("isNonEmptyShape: 공백만이면 빈 것", () => {
    expect(isNonEmptyShape(txt({ text: "   " }))).toBe(false);
    expect(isNonEmptyShape(txt({ text: "x" }))).toBe(true);
  });

  it("textSize/shapeBounds: 줄 수·최대 줄 길이 기반", () => {
    const [w, h] = textSize(txt({ text: "ab\ncde", fontSize: 10 }));
    expect(h).toBeCloseTo(2 * 10 * 1.3);
    expect(w).toBeCloseTo(3 * 10 * 0.6);
    expect(shapeBounds(txt({ fontSize: 10, text: "ab" }))[0]).toBe(10);
  });

  it("translate/scale: 위치 이동·세로 배율로 글자 크기 조절", () => {
    expect((translateShape(txt(), 5, 5) as TextShape).pos).toEqual([15, 25]);
    const sc = scaleShape(txt({ fontSize: 10 }), [10, 20, 100, 100], [10, 20, 100, 200]) as TextShape;
    expect(sc.fontSize).toBe(20); // sy = 2
  });
});

describe("이미지(image)", () => {
  const im = (
    rect: [number, number, number, number],
    extra: Partial<ImageShape> = {},
  ): ImageShape => ({ id: "i1", type: "image", src: "pic.png", rect, ...extra });

  it("직렬화·복원(src/rect/opacity)", () => {
    const doc: DrawDoc = { version: 2, pages: { 1: [im([10, 20, 100, 80], { opacity: 0.5 })] } };
    const r = parseDrawDoc(serializeDrawDoc(doc)).pages[1][0] as ImageShape;
    expect(r.type).toBe("image");
    expect(r.src).toBe("pic.png");
    expect(r.rect).toEqual([10, 20, 100, 80]);
    expect(r.opacity).toBe(0.5);
  });

  it("src 없거나 rect 불완전하면 버린다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: {
        1: [
          { id: "a", type: "image", rect: [0, 0, 10, 10] }, // src 없음
          { id: "b", type: "image", src: "x.png", rect: [0, 0, 10] }, // rect 길이 3
        ],
      },
    });
    expect(isEmptyDoc(parseDrawDoc(json))).toBe(true);
  });

  it("isNonEmptyShape: 0 크기 이미지는 빈 것", () => {
    expect(isNonEmptyShape(im([0, 0, 0, 0]))).toBe(false);
    expect(isNonEmptyShape(im([0, 0, 10, 10]))).toBe(true);
  });

  it("bounds/translate/scale: rect 기반", () => {
    expect(shapeBounds(im([5, 5, 30, 40]))).toEqual([5, 5, 30, 40]);
    expect((translateShape(im([0, 0, 10, 10]), 3, 4) as ImageShape).rect).toEqual([3, 4, 10, 10]);
    const sc = scaleShape(im([0, 0, 10, 10]), [0, 0, 10, 10], [0, 0, 20, 20]) as ImageShape;
    expect(sc.rect).toEqual([0, 0, 20, 20]);
  });

  it("imageAssetPrefixOf: PDF 이름 기반 접두사", () => {
    expect(imageAssetPrefixOf("foo.pdf")).toBe("foo.pdf.draw");
  });
});

describe("불투명도", () => {
  it("opacity 가 없으면 도구 기본값(펜 1, 형광펜 0.4)", () => {
    expect(effectiveOpacity(pen([0, 0, 1, 1]))).toBe(1);
    expect(effectiveOpacity(pen([0, 0, 1, 1], { tool: "highlighter" }))).toBe(0.4);
  });

  it("opacity 가 있으면 그 값을 쓴다(도구 무관)", () => {
    expect(effectiveOpacity(pen([0, 0, 1, 1], { opacity: 0.5 }))).toBe(0.5);
    expect(
      effectiveOpacity(pen([0, 0, 1, 1], { tool: "highlighter", opacity: 0.9 })),
    ).toBe(0.9);
  });

  it("opacity 0(완전 투명)도 유효한 값으로 본다", () => {
    expect(effectiveOpacity(pen([0, 0, 1, 1], { opacity: 0 }))).toBe(0);
  });

  it("opacity 를 직렬화·복원한다", () => {
    const doc: DrawDoc = { version: 2, pages: { 1: [pen([0, 0, 1, 1], { opacity: 0.5 })] } };
    const r = parseDrawDoc(serializeDrawDoc(doc));
    expect(r.pages[1][0].opacity).toBe(0.5);
  });

  it("opacity 가 없으면 직렬화 결과에 포함하지 않는다", () => {
    const json = serializeDrawDoc({ version: 2, pages: { 1: [pen([0, 0, 1, 1])] } });
    expect(json).not.toContain("opacity");
  });

  it("범위 밖 opacity 는 0..1 로 클램프한다", () => {
    const json = JSON.stringify({
      version: 2,
      pages: {
        1: [{ type: "path", tool: "pen", color: "#000", width: 2, opacity: 5, points: [0, 0, 1, 1] }],
      },
    });
    expect(parseDrawDoc(json).pages[1][0].opacity).toBe(1);
  });
});
