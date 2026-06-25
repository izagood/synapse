// PDF 위 드로잉의 데이터 모델·직렬화·기하 유틸 (순수 로직, GUI 비의존).
//
// 좌표계: 모든 점/굵기는 "scale 1 페이지 좌표"(pdf.js getViewport({scale:1}) 기준,
// 원점 좌상단·y 아래 방향, 단위는 PDF 포인트)로 저장한다. 줌/DPR과 무관하게
// 같은 위치를 가리키므로 재렌더·저장·베이크 모두 이 좌표만 곱해 쓰면 된다.
//
// 모델은 Shape 판별 유니온이다. 현재 멤버는 자유곡선(PathShape) 하나뿐이고,
// 후속 단계에서 line/rect/text/image 등을 같은 좌표계 위에 추가한다. 각 결합
// 지점(렌더/입력/베이크)은 shape.type 으로 분기하는 디스패처 구조를 따른다.

/** 화면에서 고를 수 있는 도구. move는 그리지 않고 스크롤/줌만 한다. */
export type ToolKind =
  | "move"
  | "select"
  | "pen"
  | "highlighter"
  | "eraser"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text";

/** 자유곡선을 만드는 펜 계열 도구. */
export type StrokeTool = "pen" | "highlighter";

/** 저장되는 도형의 종류(판별자). 단계별로 멤버가 늘어난다. */
export type ShapeType = "path" | "line" | "arrow" | "rect" | "ellipse" | "text" | "image";

/** 모든 도형이 공유하는 메타. id는 선택/이동/삭제의 대상 식별자다. */
export interface ShapeBase {
  id: string;
  type: ShapeType;
}

/** 자유곡선(펜/형광펜). 기존 Stroke 를 계승한다. */
export interface PathShape extends ShapeBase {
  type: "path";
  tool: StrokeTool;
  /** "#rrggbb" 형식 색 */
  color: string;
  /** scale 1 페이지 좌표 단위(pt) 선 굵기 */
  width: number;
  /** 0..1 불투명도. 생략하면 도구 기본값(형광펜 0.4, 펜 1)을 쓴다. */
  opacity?: number;
  /** 평탄화된 좌표열 [x0,y0,x1,y1,...] (scale 1 좌표) */
  points: number[];
}

/** 직선/화살표. a→b 두 점으로 정의한다(화살표는 b 끝에 화살촉). */
export interface LineShape extends ShapeBase {
  type: "line" | "arrow";
  /** "#rrggbb" 형식 선 색 */
  color: string;
  /** scale 1 좌표 단위(pt) 선 굵기 */
  width: number;
  /** 0..1 불투명도(생략 시 1) */
  opacity?: number;
  /** 시작점 [x,y] (scale 1) */
  a: [number, number];
  /** 끝점 [x,y] (scale 1) */
  b: [number, number];
}

/** 사각형/타원. 정규화된 bbox [x,y,w,h] (w,h≥0). */
export interface RectLikeShape extends ShapeBase {
  type: "rect" | "ellipse";
  /** 테두리 색(생략 시 테두리 없음) */
  stroke?: string;
  /** 채우기 색(생략 시 투명) */
  fill?: string;
  /** 테두리 굵기(pt) */
  width: number;
  /** 0..1 불투명도(생략 시 1) */
  opacity?: number;
  /** rect 모서리 둥글기(pt, rect 전용) */
  radius?: number;
  /** 정규화된 bbox [x,y,w,h] (scale 1) */
  rect: [number, number, number, number];
}

/** 텍스트 박스. pos(좌상단) 기준, \n 으로 여러 줄. */
export interface TextShape extends ShapeBase {
  type: "text";
  text: string;
  /** "#rrggbb" 형식 글자 색 */
  color: string;
  /** 글자 크기(pt, scale 1) */
  fontSize: number;
  /** 0..1 불투명도(생략 시 1) */
  opacity?: number;
  /** 좌상단 기준점 [x,y] (scale 1) */
  pos: [number, number];
}

/**
 * 이미지. src 는 PDF 와 같은 폴더에 저장된 파일명(상대). JSON 비대를 피하려고
 * 픽셀 데이터는 사이드카에 넣지 않고 별도 파일로 둔다.
 */
export interface ImageShape extends ShapeBase {
  type: "image";
  /** PDF 와 같은 폴더 내 이미지 파일명 */
  src: string;
  /** 0..1 불투명도(생략 시 1) */
  opacity?: number;
  /** 정규화된 bbox [x,y,w,h] (scale 1) */
  rect: [number, number, number, number];
}

/** 디스크에 저장되는 도형. 단계별로 유니온이 넓어진다. */
export type Shape = PathShape | LineShape | RectLikeShape | TextShape | ImageShape;

/** PDF 경로 → 그 PDF 의 그림 이미지에 쓸 파일명 접두사. */
export function imageAssetPrefixOf(pdfName: string): string {
  return `${pdfName}.draw`;
}

/** 텍스트 크기 추정 상수(선택 박스/히트테스트용 근사). */
const TEXT_CHAR_W = 0.6; // fontSize 대비 평균 글자 폭
const TEXT_LINE_H = 1.3; // 줄 높이 배수

/** 텍스트의 추정 [폭, 높이] (scale 1). 줄 수·최대 줄 길이 기반 근사. */
export function textSize(s: TextShape): [number, number] {
  const lines = s.text.split("\n");
  const cols = Math.max(1, ...lines.map((l) => l.length));
  return [cols * s.fontSize * TEXT_CHAR_W, lines.length * s.fontSize * TEXT_LINE_H];
}

export interface DrawDoc {
  version: 2;
  /** 1-based 페이지 번호 → 그 페이지의 도형들(그린 순서 = z-순서) */
  pages: Record<number, Shape[]>;
}

export const DRAW_DOC_VERSION = 2 as const;
/** 형광펜 기본 불투명도(펜은 1.0). 사용자가 opacity 를 지정하면 그 값이 우선. */
export const HIGHLIGHTER_OPACITY = 0.4;

/** 도형의 실제 불투명도. opacity 가 있으면 그 값, 없으면 형광펜만 0.4·나머지 1. */
export function effectiveOpacity(shape: Shape): number {
  if (typeof shape.opacity === "number") return shape.opacity;
  if (shape.type === "path" && shape.tool === "highlighter") return HIGHLIGHTER_OPACITY;
  return 1;
}

/** 짧은 도형 식별자. 페이지당 도형 수가 적어 충돌 확률은 무시 가능. */
export function newShapeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptyDrawDoc(): DrawDoc {
  return { version: DRAW_DOC_VERSION, pages: {} };
}

export function isEmptyDoc(doc: DrawDoc): boolean {
  return Object.values(doc.pages).every((s) => s.length === 0);
}

export function countShapes(doc: DrawDoc): number {
  return Object.values(doc.pages).reduce((n, s) => n + s.length, 0);
}

/** 페이지의 도형 배열을 반환(없으면 빈 배열). 반환값을 직접 변형하지 말 것. */
export function shapesOnPage(doc: DrawDoc, page: number): Shape[] {
  return doc.pages[page] ?? [];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function asPoint(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])
    ? [v[0], v[1]]
    : null;
}

function asRect(v: unknown): [number, number, number, number] | null {
  return Array.isArray(v) && v.length === 4 && v.every(isNum)
    ? [v[0], v[1], v[2], v[3]]
    : null;
}

function coerceOpacity(v: unknown): number | undefined {
  return isNum(v) ? clamp01(v) : undefined;
}

/** 도형이 화면/저장에 의미가 있는 최소 데이터를 갖췄는지(빈 도형 제거용). */
export function isNonEmptyShape(s: Shape): boolean {
  switch (s.type) {
    case "path":
      return s.points.length >= 2;
    case "line":
    case "arrow":
      return s.a[0] !== s.b[0] || s.a[1] !== s.b[1];
    case "rect":
    case "ellipse":
      return s.rect[2] > 0 || s.rect[3] > 0;
    case "image":
      return s.rect[2] > 0 && s.rect[3] > 0;
    case "text":
      return s.text.trim().length > 0;
  }
}

/**
 * 임의 입력을 Shape 로 강제 변환한다. v1(타입 없는 Stroke)과 v2(type 보유)를
 * 모두 받아 마이그레이션한다. 변환 불가/미지 타입은 null 을 돌려준다.
 */
function coerceShape(raw: unknown): Shape | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  // v1 호환: type 이 없으면 자유곡선(path)으로 본다.
  const type = o.type === undefined ? "path" : o.type;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : newShapeId();
  const opacity = coerceOpacity(o.opacity);
  const withOpacity = opacity !== undefined ? { opacity } : {};

  if (type === "path") {
    if (!(o.tool === "pen" || o.tool === "highlighter")) return null;
    if (typeof o.color !== "string") return null;
    if (!isNum(o.width)) return null;
    if (
      !Array.isArray(o.points) ||
      o.points.length < 2 ||
      o.points.length % 2 !== 0 ||
      !o.points.every(isNum)
    ) {
      return null;
    }
    return {
      id,
      type: "path",
      tool: o.tool,
      color: o.color,
      width: o.width,
      ...withOpacity,
      points: o.points as number[],
    };
  }

  if (type === "line" || type === "arrow") {
    const a = asPoint(o.a);
    const b = asPoint(o.b);
    if (!a || !b) return null;
    if (typeof o.color !== "string") return null;
    if (!isNum(o.width)) return null;
    return { id, type, color: o.color, width: o.width, ...withOpacity, a, b };
  }

  if (type === "rect" || type === "ellipse") {
    const rect = asRect(o.rect);
    if (!rect) return null;
    if (!isNum(o.width)) return null;
    const stroke = typeof o.stroke === "string" ? o.stroke : undefined;
    const fill = typeof o.fill === "string" ? o.fill : undefined;
    if (!stroke && !fill) return null; // 테두리도 채움도 없으면 보이지 않음
    const radius = type === "rect" && isNum(o.radius) ? Math.max(0, o.radius) : undefined;
    return {
      id,
      type,
      ...(stroke ? { stroke } : {}),
      ...(fill ? { fill } : {}),
      width: o.width,
      ...withOpacity,
      ...(radius !== undefined ? { radius } : {}),
      rect,
    };
  }

  if (type === "text") {
    if (typeof o.text !== "string" || o.text.length === 0) return null;
    if (typeof o.color !== "string") return null;
    if (!isNum(o.fontSize)) return null;
    const pos = asPoint(o.pos);
    if (!pos) return null;
    return { id, type: "text", text: o.text, color: o.color, fontSize: o.fontSize, ...withOpacity, pos };
  }

  if (type === "image") {
    if (typeof o.src !== "string" || o.src.length === 0) return null;
    const rect = asRect(o.rect);
    if (!rect) return null;
    return { id, type: "image", src: o.src, ...withOpacity, rect };
  }

  // 미지 타입(상위 버전이 저장한 것)은 조용히 버린다.
  return null;
}

/** 한 도형을 저장용 평이 객체로(좌표는 소수 2자리 반올림). */
function serializeShape(s: Shape): Record<string, unknown> {
  const withOpacity = s.opacity !== undefined ? { opacity: round2(s.opacity) } : {};
  switch (s.type) {
    case "path":
      return {
        id: s.id,
        type: "path",
        tool: s.tool,
        color: s.color,
        width: round2(s.width),
        ...withOpacity,
        points: s.points.map(round2),
      };
    case "line":
    case "arrow":
      return {
        id: s.id,
        type: s.type,
        color: s.color,
        width: round2(s.width),
        ...withOpacity,
        a: [round2(s.a[0]), round2(s.a[1])],
        b: [round2(s.b[0]), round2(s.b[1])],
      };
    case "rect":
    case "ellipse":
      return {
        id: s.id,
        type: s.type,
        ...(s.stroke ? { stroke: s.stroke } : {}),
        ...(s.fill ? { fill: s.fill } : {}),
        width: round2(s.width),
        ...withOpacity,
        ...(s.radius !== undefined ? { radius: round2(s.radius) } : {}),
        rect: s.rect.map(round2),
      };
    case "text":
      return {
        id: s.id,
        type: "text",
        text: s.text,
        color: s.color,
        fontSize: round2(s.fontSize),
        ...withOpacity,
        pos: [round2(s.pos[0]), round2(s.pos[1])],
      };
    case "image":
      return {
        id: s.id,
        type: "image",
        src: s.src,
        ...withOpacity,
        rect: s.rect.map(round2),
      };
  }
}

/** DrawDoc → JSON 문자열. 빈 도형/빈 페이지는 저장하지 않는다. */
export function serializeDrawDoc(doc: DrawDoc): string {
  const pages: Record<number, unknown[]> = {};
  for (const [page, shapes] of Object.entries(doc.pages)) {
    const kept = shapes.filter(isNonEmptyShape);
    if (kept.length === 0) continue; // 빈 페이지는 저장하지 않음
    pages[Number(page)] = kept.map(serializeShape);
  }
  return JSON.stringify({ version: DRAW_DOC_VERSION, pages });
}

/**
 * JSON 문자열 → DrawDoc. 손상/부분 손상된 입력도 PDF 열람을 막지 않도록
 * 유효하지 않은 도형은 조용히 버리고 가능한 만큼 복구한다. v1 문서는
 * 자동으로 v2 로 마이그레이션한다. 완전히 못 읽으면 빈 문서를 돌려준다.
 */
export function parseDrawDoc(json: string): DrawDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyDrawDoc();
  }
  if (typeof raw !== "object" || raw === null) return emptyDrawDoc();
  const pagesRaw = (raw as { pages?: unknown }).pages;
  if (typeof pagesRaw !== "object" || pagesRaw === null) return emptyDrawDoc();

  const pages: Record<number, Shape[]> = {};
  for (const [key, val] of Object.entries(pagesRaw as Record<string, unknown>)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1) continue;
    if (!Array.isArray(val)) continue;
    const shapes = val.map(coerceShape).filter((s): s is Shape => s !== null);
    if (shapes.length > 0) pages[page] = shapes;
  }
  return { version: DRAW_DOC_VERSION, pages };
}

/** 굽기 결과 PDF 파일명. 예: `foo.pdf` → `foo (그림).pdf` */
export function bakedPdfNameOf(pdfName: string): string {
  const lower = pdfName.toLowerCase();
  const stem = lower.endsWith(".pdf") ? pdfName.slice(0, -4) : pdfName;
  return `${stem} (그림).pdf`;
}

// ---- 기하 (지우개/선택 히트테스트) ----

/** 점 (px,py) 에서 선분 (ax,ay)-(bx,by) 까지의 최단 거리. */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay); // 퇴화: 점
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** path 도형이 (x,y) 반경 radius 안에 닿는지(굵기 절반 가산). */
function pathHitsPoint(path: PathShape, x: number, y: number, radius: number): boolean {
  const pts = path.points;
  const tol = radius + path.width / 2;
  if (pts.length === 2) {
    return Math.hypot(x - pts[0], y - pts[1]) <= tol;
  }
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (distanceToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= tol) {
      return true;
    }
  }
  return false;
}

/** (x,y) 가 도형에 radius 안으로 닿으면 true. type 별로 분기한다. */
export function shapeHitsPoint(shape: Shape, x: number, y: number, radius: number): boolean {
  switch (shape.type) {
    case "path":
      return pathHitsPoint(shape, x, y, radius);
    case "line":
    case "arrow":
      return (
        distanceToSegment(x, y, shape.a[0], shape.a[1], shape.b[0], shape.b[1]) <=
        radius + shape.width / 2
      );
    case "rect": {
      const [rx, ry, rw, rh] = shape.rect;
      const tol = radius + shape.width / 2;
      const inOuter = x >= rx - tol && x <= rx + rw + tol && y >= ry - tol && y <= ry + rh + tol;
      if (!inOuter) return false;
      if (shape.fill) return true; // 채워진 사각형은 내부도 히트
      // 테두리만: 안쪽 빈 영역은 제외
      const inInner = x > rx + tol && x < rx + rw - tol && y > ry + tol && y < ry + rh - tol;
      return !inInner;
    }
    case "ellipse": {
      const [rx, ry, rw, rh] = shape.rect;
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;
      const ax = rw / 2;
      const ay = rh / 2;
      if (ax <= 0 || ay <= 0) return false;
      const tol = radius + shape.width / 2;
      const outer = ((x - cx) / (ax + tol)) ** 2 + ((y - cy) / (ay + tol)) ** 2;
      if (outer > 1) return false;
      if (shape.fill) return true;
      const inner =
        ((x - cx) / Math.max(0.0001, ax - tol)) ** 2 +
        ((y - cy) / Math.max(0.0001, ay - tol)) ** 2;
      return inner >= 1; // 테두리만: 안쪽 구멍 제외
    }
    case "text": {
      const [w, h] = textSize(shape);
      return (
        x >= shape.pos[0] - radius &&
        x <= shape.pos[0] + w + radius &&
        y >= shape.pos[1] - radius &&
        y <= shape.pos[1] + h + radius
      );
    }
    case "image": {
      const [rx, ry, rw, rh] = shape.rect;
      return x >= rx - radius && x <= rx + rw + radius && y >= ry - radius && y <= ry + rh + radius;
    }
  }
}

/** (x,y) 반경 radius 에 닿는 도형들을 제거한 새 배열을 돌려준다(원본 불변). */
export function eraseShapesAt(
  shapes: Shape[],
  x: number,
  y: number,
  radius: number,
): Shape[] {
  return shapes.filter((s) => !shapeHitsPoint(s, x, y, radius));
}

// ---- 선택/편집 (이동·리사이즈) ----

/** z-순서 역순(맨 위 우선)으로 (x,y) 에 닿는 첫 도형의 id. 없으면 null. */
export function topmostShapeAt(
  shapes: Shape[],
  x: number,
  y: number,
  radius: number,
): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapeHitsPoint(shapes[i], x, y, radius)) return shapes[i].id;
  }
  return null;
}

/** 도형의 bounding box [x,y,w,h] (scale 1). */
export function shapeBounds(s: Shape): [number, number, number, number] {
  switch (s.type) {
    case "path": {
      const pts = s.points;
      let minX = pts[0];
      let minY = pts[1];
      let maxX = pts[0];
      let maxY = pts[1];
      for (let i = 2; i + 1 < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]);
        maxX = Math.max(maxX, pts[i]);
        minY = Math.min(minY, pts[i + 1]);
        maxY = Math.max(maxY, pts[i + 1]);
      }
      return [minX, minY, maxX - minX, maxY - minY];
    }
    case "line":
    case "arrow":
      return [
        Math.min(s.a[0], s.b[0]),
        Math.min(s.a[1], s.b[1]),
        Math.abs(s.a[0] - s.b[0]),
        Math.abs(s.a[1] - s.b[1]),
      ];
    case "rect":
    case "ellipse":
    case "image":
      return [s.rect[0], s.rect[1], s.rect[2], s.rect[3]];
    case "text": {
      const [w, h] = textSize(s);
      return [s.pos[0], s.pos[1], w, h];
    }
  }
}

/** 도형을 (dx,dy) 만큼 평행이동한 새 도형(원본 불변). */
export function translateShape(s: Shape, dx: number, dy: number): Shape {
  switch (s.type) {
    case "path":
      return { ...s, points: s.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
    case "line":
    case "arrow":
      return { ...s, a: [s.a[0] + dx, s.a[1] + dy], b: [s.b[0] + dx, s.b[1] + dy] };
    case "rect":
    case "ellipse":
    case "image":
      return { ...s, rect: [s.rect[0] + dx, s.rect[1] + dy, s.rect[2], s.rect[3]] };
    case "text":
      return { ...s, pos: [s.pos[0] + dx, s.pos[1] + dy] };
  }
}

/**
 * 도형을 bbox old → next 로 선형 매핑한 새 도형(리사이즈). old 의 변이 0이면
 * 그 축은 평행이동만 한다(0 나눗셈 방지).
 */
export function scaleShape(
  s: Shape,
  old: [number, number, number, number],
  next: [number, number, number, number],
): Shape {
  const sx = old[2] !== 0 ? next[2] / old[2] : 1;
  const sy = old[3] !== 0 ? next[3] / old[3] : 1;
  const mapX = (x: number) => next[0] + (x - old[0]) * sx;
  const mapY = (y: number) => next[1] + (y - old[1]) * sy;
  switch (s.type) {
    case "path":
      return { ...s, points: s.points.map((v, i) => (i % 2 === 0 ? mapX(v) : mapY(v))) };
    case "line":
    case "arrow":
      return {
        ...s,
        a: [mapX(s.a[0]), mapY(s.a[1])],
        b: [mapX(s.b[0]), mapY(s.b[1])],
      };
    case "rect":
    case "ellipse":
    case "image":
      return { ...s, rect: [mapX(s.rect[0]), mapY(s.rect[1]), s.rect[2] * sx, s.rect[3] * sy] };
    case "text":
      return { ...s, pos: [mapX(s.pos[0]), mapY(s.pos[1])], fontSize: s.fontSize * sy };
  }
}

// ---- 곡선 스무딩 (화면 렌더·베이크 공유) ----

/** 2차 베지어 한 구간: 제어점 (cx,cy) → 끝점 (x,y). */
export interface QuadSeg {
  cx: number;
  cy: number;
  x: number;
  y: number;
}

/** moveTo 시작점 + 2차 베지어 구간들. */
export interface SmoothPath {
  startX: number;
  startY: number;
  segs: QuadSeg[];
}

/**
 * 좌표열 [x0,y0,...] 을 부드러운 2차 베지어 경로로 변환한다(중점 기법).
 * 각 내부 점을 제어점으로, 인접 점과의 중점을 끝점으로 삼아 모서리를 둥글린다.
 * 화면(canvas quadraticCurveTo)과 베이크(SVG Q)가 같은 곡선을 그리도록 공유한다.
 * 점이 없으면 null. 점 하나면 같은 자리로 미세 구간을 만들어 점이 찍히게 한다.
 */
export function smoothPath(points: number[]): SmoothPath | null {
  const n = Math.floor(points.length / 2);
  if (n < 1) return null;
  const startX = points[0];
  const startY = points[1];
  const segs: QuadSeg[] = [];

  if (n === 1) {
    // 단일 점 → 같은 자리로 미세 구간(둥근 캡이 점처럼 보임)
    segs.push({ cx: startX, cy: startY, x: startX + 0.01, y: startY + 0.01 });
    return { startX, startY, segs };
  }
  if (n === 2) {
    // 두 점 → 직선(제어점을 시작점에 둬 사실상 직선)
    segs.push({ cx: startX, cy: startY, x: points[2], y: points[3] });
    return { startX, startY, segs };
  }
  // 3점 이상 → 내부 점은 제어점, 끝점은 인접 중점.
  for (let i = 1; i < n - 1; i++) {
    const px = points[i * 2];
    const py = points[i * 2 + 1];
    const nx = points[(i + 1) * 2];
    const ny = points[(i + 1) * 2 + 1];
    segs.push({ cx: px, cy: py, x: (px + nx) / 2, y: (py + ny) / 2 });
  }
  // 마지막 점으로 마무리.
  const lx = points[(n - 1) * 2];
  const ly = points[(n - 1) * 2 + 1];
  segs.push({ cx: lx, cy: ly, x: lx, y: ly });
  return { startX, startY, segs };
}

// ---- 베이크 (SVG path) ----

/** 좌표열을 부드러운 SVG path 데이터로 변환한다(pdf-lib drawSvgPath 입력). */
export function strokeToSvgPath(points: number[]): string {
  const sp = smoothPath(points);
  if (!sp) return "";
  let d = `M ${sp.startX} ${sp.startY}`;
  for (const s of sp.segs) d += ` Q ${s.cx} ${s.cy} ${s.x} ${s.y}`;
  return d;
}
