// 노트 링크 그래프의 가벼운 force-directed 레이아웃 (FR-6.2).
// 외부 의존성(d3 등) 없이 결정적으로 좌표를 계산한다 — 테스트 가능한 순수 함수.
//
// 알고리즘: 고전적인 spring(엣지 당김) + 전하 반발(노드 밀어냄) 시뮬레이션.
// 초기 배치는 path 해시 기반의 결정적 원형 배치라 같은 입력 → 같은 출력이다.

import type { LinkGraph } from "../../ipc/types";

export interface PositionedNode {
  path: string;
  name: string;
  x: number;
  y: number;
  /** 이 노드에 연결된 엣지 수(in+out) — 시각적 크기·강조에 사용 */
  degree: number;
}

export interface GraphLayout {
  nodes: PositionedNode[];
  edges: { source: string; target: string }[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** 시뮬레이션 반복 횟수 (많을수록 안정적, 비용 ↑) */
  iterations?: number;
}

/** 경로 문자열을 0..1 사이 결정적 값으로 해시 (초기 배치 시드). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 부호 없는 32비트 → 0..1
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * 그래프에 force-directed 레이아웃을 적용해 노드 좌표를 만든다.
 *
 * 결정적: 같은 그래프·옵션이면 항상 같은 좌표를 돌려준다(난수 미사용).
 * 빈 그래프도 안전하게 처리한다.
 */
export function layoutGraph(graph: LinkGraph, opts: LayoutOptions = {}): GraphLayout {
  const width = opts.width ?? 800;
  const height = opts.height ?? 600;
  const iterations = opts.iterations ?? 300;
  const cx = width / 2;
  const cy = height / 2;

  const n = graph.nodes.length;
  // 인접(차수) 계산
  const degree = new Map<string, number>();
  for (const node of graph.nodes) degree.set(node.path, 0);
  const edges = graph.edges.filter(
    (e) => degree.has(e.source) && degree.has(e.target),
  );
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  if (n === 0) {
    return { nodes: [], edges, width, height };
  }

  // 결정적 초기 배치: 해시로 정한 각도·반지름의 원형 분포
  const radius = Math.min(width, height) * 0.4;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  graph.nodes.forEach((node, i) => {
    const angle = hash01(node.path) * Math.PI * 2;
    const r = radius * (0.3 + 0.7 * hash01(`${node.path}#r`));
    xs[i] = cx + Math.cos(angle) * r;
    ys[i] = cy + Math.sin(angle) * r;
  });

  const index = new Map<string, number>();
  graph.nodes.forEach((node, i) => index.set(node.path, i));

  // 시뮬레이션 파라미터
  const k = Math.sqrt((width * height) / Math.max(n, 1)); // 이상적 노드 간 거리
  const repulsion = k * k; // 반발 상수
  const springLen = k * 0.8; // 엣지 자연 길이
  const springStrength = 0.02;

  for (let iter = 0; iter < iterations; iter += 1) {
    // 시간이 갈수록 이동량을 줄여(annealing) 안정화
    const cooling = 1 - iter / iterations;
    const dispX = new Float64Array(n);
    const dispY = new Float64Array(n);

    // 노드 간 반발 (O(n^2) — 노트 수가 보통 수백 이하라 충분)
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = xs[i] - xs[j];
        let dy = ys[i] - ys[j];
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          // 완전히 겹치면 결정적으로 살짝 떼어놓는다
          dx = (i - j) * 0.01 + 0.01;
          dy = (i + j) * 0.01 + 0.01;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        const force = repulsion / dist2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        dispX[i] += fx;
        dispY[i] += fy;
        dispX[j] -= fx;
        dispY[j] -= fy;
      }
    }

    // 엣지 스프링 당김
    for (const e of edges) {
      const a = index.get(e.source)!;
      const b = index.get(e.target)!;
      const dx = xs[a] - xs[b];
      const dy = ys[a] - ys[b];
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist - springLen) * springStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      dispX[a] -= fx;
      dispY[a] -= fy;
      dispX[b] += fx;
      dispY[b] += fy;
    }

    // 중심으로 약하게 끌어 그래프가 흩어지지 않게 한다
    const gravity = 0.01;
    for (let i = 0; i < n; i += 1) {
      dispX[i] += (cx - xs[i]) * gravity;
      dispY[i] += (cy - ys[i]) * gravity;
    }

    // 이동량 제한 + 적용
    const maxMove = k * cooling;
    for (let i = 0; i < n; i += 1) {
      const len = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 1;
      const limited = Math.min(len, maxMove);
      xs[i] += (dispX[i] / len) * limited;
      ys[i] += (dispY[i] / len) * limited;
    }
  }

  // 시뮬레이션이 끝난 뒤 한 번만 전체 bounding box를 뷰포트에 맞춘다.
  // 반복마다 좌표를 사각형으로 클램프하면 반발력에 밀린 노드가 경계에
  // 일렬로 들러붙어 그래프가 네모 상자에 갇힌 윤곽으로 굳는다 — 대신
  // 자유롭게 퍼진 모양을 그대로 축소·중앙 정렬해 담는다(확대는 하지
  // 않아 노트가 적을 때 부자연스럽게 벌어지지 않는다).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const pad = 40;
  const scale = Math.min(
    1,
    (width - pad * 2) / Math.max(maxX - minX, 1),
    (height - pad * 2) / Math.max(maxY - minY, 1),
  );
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  for (let i = 0; i < n; i += 1) {
    xs[i] = cx + (xs[i] - midX) * scale;
    ys[i] = cy + (ys[i] - midY) * scale;
  }

  const nodes: PositionedNode[] = graph.nodes.map((node, i) => ({
    path: node.path,
    name: node.name,
    x: xs[i],
    y: ys[i],
    degree: degree.get(node.path) ?? 0,
  }));

  return { nodes, edges, width, height };
}

/** 한 노드에 인접한 노드 경로 집합 (호버 강조용). 방향 무시(in+out). */
export function adjacencyOf(graph: LinkGraph, path: string): Set<string> {
  const adj = new Set<string>();
  for (const e of graph.edges) {
    if (e.source === path) adj.add(e.target);
    else if (e.target === path) adj.add(e.source);
  }
  return adj;
}

// ── 라벨 충돌 회피 ──────────────────────────────────────────────
// 라벨은 노드 점 오른쪽에 그려진다. 노드가 빽빽하면 글자끼리 겹쳐
// 읽을 수 없으므로(FR-6.2 개선), 우선순위가 높은 라벨부터 자리를 잡고
// 이미 놓인 라벨 사각형과 겹치는 라벨은 숨긴다. 좌표는 레이아웃 공간
// 기준 — 텍스트와 노드가 함께 확대되므로 줌과 무관하게 결정적이다.

/** 라벨이 노드 점에서 떨어진 가로 간격(px, 레이아웃 공간). */
export const LABEL_GAP = 4;
/** 라벨 한 줄의 대략적 높이(px). 폰트 11 + 위아래 여유. */
export const LABEL_HEIGHT = 14;
/** 겹침 판정 시 라벨 사이에 두는 최소 여백(px). */
const LABEL_MARGIN = 2;

export interface LabelCandidate {
  path: string;
  /** 노드 중심 좌표 */
  x: number;
  y: number;
  /** 노드 반지름 — 라벨은 x + r + LABEL_GAP 부터 시작 */
  r: number;
  /** 추정 글자 폭(px) */
  width: number;
  /** 클수록 먼저 자리를 잡는다(겹치면 우선) */
  priority: number;
  /** 항상 표시(겹쳐도 숨기지 않음) — 호버/현재 노트 등 */
  force?: boolean;
}

/**
 * 라벨 글자 폭을 추정한다(px). CJK 문자는 거의 정사각(1em),
 * 라틴 문자는 약 0.55em 폭으로 잡는다 — 캔버스 측정 없이 충분히 근사.
 */
export function estimateLabelWidth(text: string, fontSize = 11): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    units += isWideChar(code) ? 1 : 0.55;
  }
  return units * fontSize;
}

/** 동아시아 전각(CJK·한글·가나 등) 문자인지 대략 판정. */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 부수~한글 이전
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) || // CJK 호환 한자
    (code >= 0xff00 && code <= 0xff60) || // 전각 영숫자·기호
    (code >= 0x20000 && code <= 0x3fffd) // CJK 확장
  );
}

/**
 * 겹치지 않게 표시할 라벨 집합을 고른다. 우선순위(force 우선, 그다음
 * priority)가 높은 라벨부터 자리를 잡고, 이미 놓인 라벨과 겹치면 숨긴다.
 * force 라벨은 겹쳐도 표시하되 자리는 차지해 다른 라벨이 피하게 한다.
 *
 * 순수·결정적: 같은 입력이면 항상 같은 집합을 돌려준다.
 * @returns 표시할 노드 path 집합
 */
export function placeLabels(cands: LabelCandidate[]): Set<string> {
  const order = [...cands].sort((a, b) => {
    if (!!b.force !== !!a.force) return a.force ? -1 : 1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const placed: { l: number; t: number; r: number; b: number }[] = [];
  const shown = new Set<string>();
  for (const c of order) {
    const left = c.x + c.r + LABEL_GAP - LABEL_MARGIN;
    const right = c.x + c.r + LABEL_GAP + c.width + LABEL_MARGIN;
    const top = c.y - LABEL_HEIGHT / 2 - LABEL_MARGIN;
    const bottom = c.y + LABEL_HEIGHT / 2 + LABEL_MARGIN;
    const collides =
      !c.force &&
      placed.some((p) => left < p.r && right > p.l && top < p.b && bottom > p.t);
    if (collides) continue;
    placed.push({ l: left, t: top, r: right, b: bottom });
    shown.add(c.path);
  }
  return shown;
}
