// PDF 위 자유곡선 드로잉의 데이터 모델·직렬화·기하 유틸 (순수 로직, GUI 비의존).
//
// 좌표계: 모든 점/굵기는 "scale 1 페이지 좌표"(pdf.js getViewport({scale:1}) 기준,
// 원점 좌상단·y 아래 방향, 단위는 PDF 포인트)로 저장한다. 줌/DPR과 무관하게
// 같은 위치를 가리키므로 재렌더·저장·베이크 모두 이 좌표만 곱해 쓰면 된다.

/** 화면에서 고를 수 있는 도구. move는 그리지 않고 스크롤/줌만 한다. */
export type ToolKind = "move" | "pen" | "highlighter" | "eraser";

/** 디스크에 저장되는 도구 종류(실제 획을 만드는 것만). */
export type StrokeTool = "pen" | "highlighter";

export interface Stroke {
  tool: StrokeTool;
  /** "#rrggbb" 형식 색 */
  color: string;
  /** scale 1 페이지 좌표 단위(pt) 선 굵기 */
  width: number;
  /** 평탄화된 좌표열 [x0,y0,x1,y1,...] (scale 1 좌표) */
  points: number[];
}

export interface DrawDoc {
  version: 1;
  /** 1-based 페이지 번호 → 그 페이지의 획들(그린 순서 = z-순서) */
  pages: Record<number, Stroke[]>;
}

export const DRAW_DOC_VERSION = 1 as const;
/** 형광펜 불투명도(펜은 1.0). 베이크/렌더 양쪽에서 동일하게 쓴다. */
export const HIGHLIGHTER_OPACITY = 0.4;

export function emptyDrawDoc(): DrawDoc {
  return { version: DRAW_DOC_VERSION, pages: {} };
}

export function isEmptyDoc(doc: DrawDoc): boolean {
  return Object.values(doc.pages).every((s) => s.length === 0);
}

export function countStrokes(doc: DrawDoc): number {
  return Object.values(doc.pages).reduce((n, s) => n + s.length, 0);
}

/** 페이지의 획 배열을 반환(없으면 빈 배열). 반환값을 직접 변형하지 말 것. */
export function strokesOnPage(doc: DrawDoc, page: number): Stroke[] {
  return doc.pages[page] ?? [];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function isValidStroke(s: unknown): s is Stroke {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    (o.tool === "pen" || o.tool === "highlighter") &&
    typeof o.color === "string" &&
    typeof o.width === "number" &&
    Array.isArray(o.points) &&
    o.points.length >= 2 &&
    o.points.length % 2 === 0 &&
    o.points.every((p) => typeof p === "number" && Number.isFinite(p))
  );
}

/** DrawDoc → JSON 문자열. 좌표는 소수 2자리로 반올림해 파일을 작게 유지한다. */
export function serializeDrawDoc(doc: DrawDoc): string {
  const pages: Record<number, Stroke[]> = {};
  for (const [page, strokes] of Object.entries(doc.pages)) {
    const kept = strokes.filter((s) => s.points.length >= 2);
    if (kept.length === 0) continue; // 빈 페이지는 저장하지 않음
    pages[Number(page)] = kept.map((s) => ({
      tool: s.tool,
      color: s.color,
      width: round2(s.width),
      points: s.points.map(round2),
    }));
  }
  return JSON.stringify({ version: DRAW_DOC_VERSION, pages });
}

/**
 * JSON 문자열 → DrawDoc. 손상/부분 손상된 입력도 PDF 열람을 막지 않도록
 * 유효하지 않은 획은 조용히 버리고 가능한 만큼 복구한다. 완전히 못 읽으면
 * 빈 문서를 돌려준다.
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

  const pages: Record<number, Stroke[]> = {};
  for (const [key, val] of Object.entries(pagesRaw as Record<string, unknown>)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1) continue;
    if (!Array.isArray(val)) continue;
    const strokes = val.filter(isValidStroke);
    if (strokes.length > 0) pages[page] = strokes;
  }
  return { version: DRAW_DOC_VERSION, pages };
}

/** PDF 절대경로/URI → 사이드카 경로. 예: `/a/foo.pdf` → `/a/foo.pdf.draw.json` */
export function sidecarPathOf(pdfPath: string): string {
  return `${pdfPath}.draw.json`;
}

/** 굽기 결과 PDF 파일명. 예: `foo.pdf` → `foo (그림).pdf` */
export function bakedPdfNameOf(pdfName: string): string {
  const lower = pdfName.toLowerCase();
  const stem = lower.endsWith(".pdf") ? pdfName.slice(0, -4) : pdfName;
  return `${stem} (그림).pdf`;
}

// ---- 기하 (지우개 히트테스트) ----

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

/** (x,y) 가 stroke 의 어느 선분에든 radius 안에 들어오면 true (굵기 절반 가산). */
export function strokeHitsPoint(
  stroke: Stroke,
  x: number,
  y: number,
  radius: number,
): boolean {
  const pts = stroke.points;
  const tol = radius + stroke.width / 2;
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

/** (x,y) 반경 radius 에 닿는 획들을 제거한 새 배열을 돌려준다(원본 불변). */
export function eraseStrokesAt(
  strokes: Stroke[],
  x: number,
  y: number,
  radius: number,
): Stroke[] {
  return strokes.filter((s) => !strokeHitsPoint(s, x, y, radius));
}

// ---- 베이크 (SVG path) ----

/**
 * 좌표열을 SVG path 데이터로 변환한다(pdf-lib drawSvgPath 입력).
 * 점이 하나뿐이면 아주 짧은 선분을 만들어 점이 찍히게 한다.
 */
export function strokeToSvgPath(points: number[]): string {
  if (points.length < 2) return "";
  const cmds: string[] = [`M ${points[0]} ${points[1]}`];
  for (let i = 2; i + 1 < points.length; i += 2) {
    cmds.push(`L ${points[i]} ${points[i + 1]}`);
  }
  if (points.length === 2) {
    // 단일 점 → 같은 자리로 미세 선분(둥근 캡이 점처럼 보임)
    cmds.push(`L ${points[0] + 0.01} ${points[1] + 0.01}`);
  }
  return cmds.join(" ");
}
