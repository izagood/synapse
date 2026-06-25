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
export type ToolKind = "move" | "pen" | "highlighter" | "eraser";

/** 자유곡선을 만드는 펜 계열 도구. */
export type StrokeTool = "pen" | "highlighter";

/** 저장되는 도형의 종류(판별자). 단계별로 멤버가 늘어난다. */
export type ShapeType = "path";

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

/** 디스크에 저장되는 도형. 단계별로 유니온이 넓어진다. */
export type Shape = PathShape;

export interface DrawDoc {
  version: 2;
  /** 1-based 페이지 번호 → 그 페이지의 도형들(그린 순서 = z-순서) */
  pages: Record<number, Shape[]>;
}

export const DRAW_DOC_VERSION = 2 as const;
/** 형광펜 기본 불투명도(펜은 1.0). 사용자가 opacity 를 지정하면 그 값이 우선. */
export const HIGHLIGHTER_OPACITY = 0.4;

/** path 의 실제 불투명도. opacity 가 있으면 그 값, 없으면 도구 기본값. */
export function effectiveOpacity(shape: PathShape): number {
  if (typeof shape.opacity === "number") return shape.opacity;
  return shape.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1;
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

/** 도형이 화면/저장에 의미가 있는 최소 데이터를 갖췄는지(빈 path 제거용). */
function isNonEmptyShape(s: Shape): boolean {
  switch (s.type) {
    case "path":
      return s.points.length >= 2;
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

  if (type === "path") {
    if (!(o.tool === "pen" || o.tool === "highlighter")) return null;
    if (typeof o.color !== "string") return null;
    if (typeof o.width !== "number" || !Number.isFinite(o.width)) return null;
    if (
      !Array.isArray(o.points) ||
      o.points.length < 2 ||
      o.points.length % 2 !== 0 ||
      !o.points.every((p) => typeof p === "number" && Number.isFinite(p))
    ) {
      return null;
    }
    const opacity =
      typeof o.opacity === "number" && Number.isFinite(o.opacity)
        ? Math.max(0, Math.min(1, o.opacity))
        : undefined;
    return {
      id: typeof o.id === "string" && o.id.length > 0 ? o.id : newShapeId(),
      type: "path",
      tool: o.tool,
      color: o.color,
      width: o.width,
      ...(opacity !== undefined ? { opacity } : {}),
      points: o.points as number[],
    };
  }
  // 미지 타입(상위 버전이 저장한 것)은 조용히 버린다.
  return null;
}

/** 한 도형을 저장용 평이 객체로(좌표는 소수 2자리 반올림). */
function serializeShape(s: Shape): Record<string, unknown> {
  switch (s.type) {
    case "path":
      return {
        id: s.id,
        type: "path",
        tool: s.tool,
        color: s.color,
        width: round2(s.width),
        ...(s.opacity !== undefined ? { opacity: round2(s.opacity) } : {}),
        points: s.points.map(round2),
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
