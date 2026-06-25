// Canvas scene 빌더 + 드로잉 (FR-6.2 캔버스 뷰 렌더링 레이어).
//
// buildScene: 순수 함수 — RenderInput → DrawOp[] (clear → edges → halos → nodes → labels).
//   그래프 상태를 DrawOp 리스트로 바꾼다. 픽셀 없이 테스트 가능.
// draw: buildScene 이 반환한 ops 를 실제 CanvasRenderingContext2D 에 그린다.
//   dpr 스케일·테마 색·카메라 변환 적용.
// radiusOf: GraphView 의 기존 식을 그대로 이전.

import type { SimState } from "./layout";
import type { Camera } from "./camera";

// ── 테마 ───────────────────────────────────────────────────────────

export interface GraphTheme {
  bg: string;
  edge: string;
  edgeActive: string;
  node: string;
  nodeIso: string;
  current: string;
  label: string;
  halo: string;
}

// ── 렌더 입력 ──────────────────────────────────────────────────────

export interface RenderInput {
  sim: SimState;
  cam: Camera;
  theme: GraphTheme;
  width: number;
  height: number;
  dpr: number;
  /** 마우스 호버 중인 노드 path. null = 없음 */
  hover: string | null;
  /** 클릭으로 선택된 노드 path. null = 없음. hover 와 동등하게 취급. */
  selected: string | null;
  /** 현재 열린 노트 path */
  current: string | null;
  /** hover/selected 노드의 인접 집합 */
  neighbors: Set<string> | null;
  /** 검색 일치 노드 집합 */
  matches: Set<string> | null;
  /** 겹침 회피 후 표시할 라벨 path 집합 */
  shownLabels: Set<string>;
  /** 최대 degree (0 이면 1 로 처리) */
  maxDegree: number;
}

// ── DrawOp union ───────────────────────────────────────────────────

export type DrawOp =
  | { op: "clear" }
  | { op: "edge"; active: boolean; dimmed: boolean; x1: number; y1: number; x2: number; y2: number }
  | { op: "halo"; x: number; y: number; r: number }
  | { op: "node"; x: number; y: number; r: number; kind: "iso" | "linked" | "current" | "active"; dimmed: boolean }
  | { op: "label"; x: number; y: number; text: string };

// ── 헬퍼 ──────────────────────────────────────────────────────────

/** 연결 수(degree)에 비례한 노드 반지름 — GraphView 의 식을 그대로 이전 */
export function radiusOf(degree: number, maxDegree: number): number {
  return degree > 0 ? 5 + (degree / maxDegree) * 9 : 3.2;
}

/** 파일 확장자를 제거한 표시명 */
function displayName(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

// ── buildScene ────────────────────────────────────────────────────

/**
 * 순수 함수: RenderInput → DrawOp[].
 *
 * 순서: clear → edges → halos → nodes → labels.
 *
 * selected 해석:
 *   selected 를 hover 와 동등하게 취급한다. "focusing" 판정은
 *   hover || selected || matches 중 하나라도 비null 이면 true.
 *   isActive 는 matches 우선, 그다음 hover/selected/neighbors 로 판정.
 *   이렇게 하면 클릭으로 노드를 선택했을 때 인접 노드·엣지 강조가 hover 와
 *   동일하게 동작하고, Task 11 GraphView 가 두 상태를 독립적으로 관리할 수 있다.
 */
export function buildScene(input: RenderInput): DrawOp[] {
  const { sim, theme: _theme, hover, selected, current, neighbors, matches, shownLabels, maxDegree } = input;
  // theme 은 draw() 에서만 사용 — buildScene 에서는 참조하지 않는다.
  void _theme;

  const safeMax = maxDegree > 0 ? maxDegree : 1;

  // focusing: 강조 모드 (hover, selected, 검색 결과 중 하나라도)
  const focusing = hover != null || selected != null || matches != null;

  /** 한 노드가 강조 대상인지 */
  const isActive = (path: string): boolean => {
    if (matches) return matches.has(path);
    // hover 와 selected 모두 활성으로 취급
    if (hover && (path === hover || (neighbors?.has(path) ?? false))) return true;
    if (selected && (path === selected || (neighbors?.has(path) ?? false))) return true;
    return false;
  };

  const ops: DrawOp[] = [];

  // 1. clear
  ops.push({ op: "clear" });

  // 2. edges — clear 다음, halo·node 전
  const posByPath = new Map(sim.nodes.map((n) => [n.path, { x: n.x, y: n.y }]));
  for (const e of sim.edges) {
    const a = posByPath.get(e.source);
    const b = posByPath.get(e.target);
    if (!a || !b) continue;
    const active = isActive(e.source) || isActive(e.target);
    const dimmed = focusing && !active;
    ops.push({ op: "edge", active, dimmed, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }

  // 3. halos — edges 다음, nodes 전 (halo 가 노드 아래에 깔림)
  for (const n of sim.nodes) {
    const linked = n.degree > 0;
    const isCurrent = n.path === current;
    if (!linked && !isCurrent) continue;
    const r = radiusOf(n.degree, safeMax);
    ops.push({ op: "halo", x: n.x, y: n.y, r: r * 2.4 });
  }

  // 4. nodes
  for (const n of sim.nodes) {
    const isCurrent = n.path === current;
    const active = isActive(n.path);
    const dimmed = focusing && !active && !isCurrent;
    const linked = n.degree > 0;
    const r = radiusOf(n.degree, safeMax);

    // kind 결정: 우선순위 active > current > linked > iso
    let kind: "iso" | "linked" | "current" | "active";
    if (active) kind = "active";
    else if (isCurrent) kind = "current";
    else if (linked) kind = "linked";
    else kind = "iso";

    ops.push({ op: "node", x: n.x, y: n.y, r, kind, dimmed });
  }

  // 5. labels
  for (const n of sim.nodes) {
    if (!shownLabels.has(n.path)) continue;
    const r = radiusOf(n.degree, safeMax);
    ops.push({ op: "label", x: n.x + r + 4, y: n.y + 4, text: displayName(n.name) });
  }

  return ops;
}

// ── draw ──────────────────────────────────────────────────────────

/**
 * buildScene 이 반환한 DrawOp[] 를 ctx 에 그린다.
 *
 * - dpr 스케일: setTransform 으로 먼저 적용 → 스크린 픽셀과 1:1 매핑.
 * - 카메라 변환: world 좌표 → screen 좌표 (k, tx, ty).
 * - 선 굵기는 스크린 공간(non-scaling-stroke 동등): dpr 역수로 보정하지
 *   않고 1px 고정으로 그린다(카메라 scale 과 무관하게 얇게 유지).
 */
export function draw(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { theme, width, height, dpr, cam } = input;
  const ops = buildScene(input);

  // 캔버스 물리 해상도에 맞게 스케일
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  for (const op of ops) {
    switch (op.op) {
      case "clear": {
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, width, height);
        break;
      }
      case "edge": {
        // world → screen
        const x1 = op.x1 * cam.k + cam.tx;
        const y1 = op.y1 * cam.k + cam.ty;
        const x2 = op.x2 * cam.k + cam.tx;
        const y2 = op.y2 * cam.k + cam.ty;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = op.active ? theme.edgeActive : theme.edge;
        ctx.globalAlpha = op.dimmed ? 0.15 : 1;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        break;
      }
      case "halo": {
        const sx = op.x * cam.k + cam.tx;
        const sy = op.y * cam.k + cam.ty;
        ctx.beginPath();
        ctx.arc(sx, sy, op.r * cam.k, 0, Math.PI * 2);
        ctx.fillStyle = theme.halo;
        ctx.globalAlpha = 0.12;
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case "node": {
        const sx = op.x * cam.k + cam.tx;
        const sy = op.y * cam.k + cam.ty;
        const sr = op.r * cam.k;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        let fill: string;
        if (op.kind === "active") fill = theme.edgeActive;
        else if (op.kind === "current") fill = theme.current;
        else if (op.kind === "iso") fill = theme.nodeIso;
        else fill = theme.node; // "linked"
        ctx.fillStyle = fill;
        ctx.globalAlpha = op.dimmed ? 0.2 : 1;
        ctx.fill();
        ctx.strokeStyle = op.kind === "current" ? theme.halo : "transparent";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        break;
      }
      case "label": {
        const sx = op.x * cam.k + cam.tx;
        const sy = op.y * cam.k + cam.ty;
        ctx.fillStyle = theme.label;
        ctx.font = `11px system-ui, sans-serif`;
        ctx.fillText(op.text, sx, sy);
        break;
      }
    }
  }
}
