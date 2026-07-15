// 노트 링크 그래프의 가벼운 force-directed 레이아웃 (FR-6.2).
// 외부 의존성(d3 등) 없이 결정적으로 좌표를 계산한다 — 테스트 가능한 순수 함수.
//
// 알고리즘: 고전적인 spring(엣지 당김) + 전하 반발(노드 밀어냄) 시뮬레이션.
// 초기 배치는 path 해시 기반의 결정적 원형 배치라 같은 입력 → 같은 출력이다.
//
// 성능 (실측: 노트 623개·엣지 52개에서 WKWebView 기준 ~3초 → 이하 3단 개선):
// 1. 고립 노드(degree 0)는 시뮬레이션에서 제외하고 결정적 해바라기 배치.
//    노트 볼트 그래프는 대개 극도로 희소해 이것만으로 반발 계산이 수십 배 준다.
// 2. 반복 횟수를 규모에 적응시키고, 움직임이 잦아들면 조기 종료한다.
// 3. 연결 노드가 많으면(BH_THRESHOLD 초과) 반발을 Barnes-Hut로 근사한다.

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
  /** 시뮬레이션 반복 횟수 (많을수록 안정적, 비용 ↑). 미지정 시 규모 적응. */
  iterations?: number;
}

/** 시뮬레이션 노드 수가 이 값을 넘으면 반발 계산을 Barnes-Hut 근사로 바꾼다. */
export const BH_THRESHOLD = 320;

/** 반복당 최대 이동이 이 값(px) 미만이면 수렴으로 보고 조기 종료한다. */
const CONVERGENCE_EPS = 0.3;

/**
 * 규모 적응 반복 횟수: 수백 노드까지는 300회, 그 이상은 반복 총비용이
 * 일정하도록 반비례로 줄인다(하한 80).
 */
export function adaptiveIterations(nSim: number): number {
  if (nSim <= 300) return 300;
  return Math.max(80, Math.round((300 * 300) / nSim));
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

// 해바라기(golden-angle) 배치: 인덱스만으로 정해지는 결정적·균일 분포.
// 고립 노드를 힘 계산 없이 겹침 적게 흩어 놓는 데 쓴다.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * idxs의 노드를 (cx, cy) 중심 타원 고리(rInnerFrac..1 × 반지름)에
 * 면적 균일하게 배치한다. 순서 기반이라 같은 입력 → 같은 출력.
 */
function placeSunflower(
  idxs: number[],
  xs: Float64Array,
  ys: Float64Array,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rInnerFrac: number,
): void {
  const count = idxs.length;
  const inner2 = rInnerFrac * rInnerFrac;
  idxs.forEach((idx, i) => {
    const u = (i + 0.5) / count;
    // 단위 고리에서 면적 균일한 반지름
    const r = Math.sqrt(inner2 + u * (1 - inner2));
    const a = i * GOLDEN_ANGLE;
    xs[idx] = cx + Math.cos(a) * r * rx;
    ys[idx] = cy + Math.sin(a) * r * ry;
  });
}

// ── 반발력 계산 ──────────────────────────────────────────────
// 두 방식 모두 같은 물리(쿨롱형 repulsion/dist²)를 쓴다. exact는 모든 쌍,
// bh는 먼 노드 무리를 질량중심 하나로 근사(θ 기준)한다. 테스트에서 θ=0으로
// 두면 bh가 exact와 일치해야 한다는 성질로 정확성을 검증한다.

/** 모든 쌍 O(m²) 반발. dispX/Y에 누적한다. (테스트에서 bh와 대조용으로 export) */
export function repulsionExact(
  xs: Float64Array,
  ys: Float64Array,
  m: number,
  repulsion: number,
  dispX: Float64Array,
  dispY: Float64Array,
): void {
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
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
}

// Barnes-Hut 쿼드트리. 노드 삽입 순서가 고정이므로 트리도 결정적이다.
interface QuadCell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 이 셀 아래 노드 수(질량) */
  mass: number;
  /** 질량중심 */
  comX: number;
  comY: number;
  /** 내부 셀이면 4분할 자식, 리프면 null */
  kids: (QuadCell | null)[] | null;
  /** 리프에 담긴 노드 인덱스들(동일 좌표 뭉침 대비 복수 허용) */
  members: number[];
}

const MAX_DEPTH = 24;

function newCell(x0: number, y0: number, x1: number, y1: number): QuadCell {
  return { x0, y0, x1, y1, mass: 0, comX: 0, comY: 0, kids: null, members: [] };
}

function insert(
  cell: QuadCell,
  idx: number,
  xs: Float64Array,
  ys: Float64Array,
  depth: number,
): void {
  cell.mass += 1;
  cell.comX += (xs[idx] - cell.comX) / cell.mass;
  cell.comY += (ys[idx] - cell.comY) / cell.mass;

  if (cell.kids === null) {
    cell.members.push(idx);
    // 리프 분할: 둘 이상 모였고 아직 깊이 여유가 있으면 4분할해 재분배
    if (cell.members.length > 1 && depth < MAX_DEPTH) {
      const moved = cell.members;
      cell.members = [];
      cell.kids = [null, null, null, null];
      for (const m of moved) place(cell, m, xs, ys, depth);
    }
    return;
  }
  place(cell, idx, xs, ys, depth);
}

function place(
  cell: QuadCell,
  idx: number,
  xs: Float64Array,
  ys: Float64Array,
  depth: number,
): void {
  const mx = (cell.x0 + cell.x1) / 2;
  const my = (cell.y0 + cell.y1) / 2;
  const right = xs[idx] >= mx;
  const bottom = ys[idx] >= my;
  const q = (bottom ? 2 : 0) + (right ? 1 : 0);
  const kids = cell.kids!;
  if (!kids[q]) {
    kids[q] = newCell(
      right ? mx : cell.x0,
      bottom ? my : cell.y0,
      right ? cell.x1 : mx,
      bottom ? cell.y1 : my,
    );
  }
  insert(kids[q]!, idx, xs, ys, depth + 1);
}

/**
 * Barnes-Hut 근사 반발 O(m log m). theta가 작을수록 정확(0 = exact와 동일).
 * (테스트 전용으로 theta를 노출한다 — 실사용은 기본값)
 */
export function repulsionBH(
  xs: Float64Array,
  ys: Float64Array,
  m: number,
  repulsion: number,
  dispX: Float64Array,
  dispY: Float64Array,
  theta = 0.9,
): void {
  if (m < 2) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < m; i += 1) {
    if (xs[i] < x0) x0 = xs[i];
    if (ys[i] < y0) y0 = ys[i];
    if (xs[i] > x1) x1 = xs[i];
    if (ys[i] > y1) y1 = ys[i];
  }
  // 정사각 루트 셀(분할 안정성) + 경계 여유
  const size = Math.max(x1 - x0, y1 - y0, 1) + 1;
  const root = newCell(x0, y0, x0 + size, y0 + size);
  for (let i = 0; i < m; i += 1) insert(root, i, xs, ys, 0);

  const theta2 = theta * theta;
  // 재귀 대신 명시적 스택 — 깊은 트리에서도 안전하고 순서가 결정적이다.
  const stack: QuadCell[] = [];
  for (let i = 0; i < m; i += 1) {
    stack.length = 0;
    stack.push(root);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      let dx = xs[i] - cell.comX;
      let dy = ys[i] - cell.comY;
      let dist2 = dx * dx + dy * dy;
      const cellSize = cell.x1 - cell.x0;

      // 충분히 멀면 셀 전체를 질량중심 하나로 근사
      if (cell.kids !== null) {
        if (cellSize * cellSize < theta2 * dist2 && dist2 > 0) {
          const dist = Math.sqrt(dist2);
          const force = (repulsion * cell.mass) / dist2;
          dispX[i] += (dx / dist) * force;
          dispY[i] += (dy / dist) * force;
        } else {
          for (const kid of cell.kids) if (kid) stack.push(kid);
        }
        continue;
      }

      // 리프: 담긴 노드들과 정확 상호작용 (자기 자신 제외)
      for (const j of cell.members) {
        if (j === i) continue;
        dx = xs[i] - xs[j];
        dy = ys[i] - ys[j];
        dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          // exact와 같은 결정적 분리 규칙
          dx = (i - j) * 0.01 + 0.01;
          dy = (i + j) * 0.01 + 0.01;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        const force = repulsion / dist2;
        dispX[i] += (dx / dist) * force;
        dispY[i] += (dy / dist) * force;
      }
    }
  }
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

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);

  // 시뮬레이션 대상(링크 있음)과 고립 노드를 나눈다.
  const simIdx: number[] = [];
  const orphanIdx: number[] = [];
  graph.nodes.forEach((node, i) => {
    ((degree.get(node.path) ?? 0) > 0 ? simIdx : orphanIdx).push(i);
  });

  // 고립 노드: 결정적 해바라기 배치. 시뮬레이션 노드가 있으면 외곽 고리로
  // 밀어 중앙의 연결 구조와 시각적으로 분리한다.
  const pad = 24;
  if (orphanIdx.length > 0) {
    placeSunflower(
      orphanIdx,
      xs,
      ys,
      cx,
      cy,
      width / 2 - pad,
      height / 2 - pad,
      simIdx.length > 0 ? 0.62 : 0,
    );
  }

  if (simIdx.length > 0) {
    // 고립 노드가 외곽 고리를 차지하면 연결 구조는 중앙 영역(반경 0.62)만
    // 쓴다 — 이상 간격 k를 그 면적 기준으로 잡아 두 영역이 겹치지 않게 한다.
    const areaFrac = orphanIdx.length > 0 ? 0.62 * 0.62 : 1;
    simulate(
      graph,
      simIdx,
      edges,
      xs,
      ys,
      width,
      height,
      areaFrac,
      opts.iterations,
    );
  }

  // 시뮬레이션이 끝난 뒤 한 번만 전체 bounding box를 뷰포트에 맞춘다.
  // 반복마다 좌표를 사각형으로 클램프하면 반발력에 밀린 노드가 경계에
  // 일렬로 들러붙어 그래프가 네모 상자에 갇힌 윤곽으로 굳는다 — 대신
  // 자유롭게 퍼진 모양을 그대로 축소·중앙 정렬해 담는다(확대는 하지
  // 않아 노트가 적을 때 부자연스럽게 벌어지지 않는다). 고립 노드 고리와
  // 중앙 연결 구조의 분리는 균등 아핀 변환이라 그대로 유지된다.
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
  const fitPad = 40;
  const scale = Math.min(
    1,
    (width - fitPad * 2) / Math.max(maxX - minX, 1),
    (height - fitPad * 2) / Math.max(maxY - minY, 1),
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

/** 연결 노드만 대상으로 force 시뮬레이션을 돌려 xs/ys의 해당 칸을 채운다. */
function simulate(
  graph: LinkGraph,
  simIdx: number[],
  edges: { source: string; target: string }[],
  xs: Float64Array,
  ys: Float64Array,
  width: number,
  height: number,
  areaFrac: number,
  iterationsOpt?: number,
): void {
  const m = simIdx.length;
  const cx = width / 2;
  const cy = height / 2;
  const iterations = iterationsOpt ?? adaptiveIterations(m);
  const spread = Math.sqrt(areaFrac); // 중앙 사용 영역의 반경 비율

  // 시뮬레이션 로컬 좌표 (전역 인덱스 → 로컬 인덱스)
  const sx = new Float64Array(m);
  const sy = new Float64Array(m);
  const localOf = new Map<string, number>();
  simIdx.forEach((gi, li) => {
    localOf.set(graph.nodes[gi].path, li);
  });

  // 결정적 초기 배치: 해시로 정한 각도·반지름의 원형 분포 (중앙 영역)
  const radius = Math.min(width, height) * 0.4 * spread;
  simIdx.forEach((gi, li) => {
    const path = graph.nodes[gi].path;
    const angle = hash01(path) * Math.PI * 2;
    const r = radius * (0.3 + 0.7 * hash01(`${path}#r`));
    sx[li] = cx + Math.cos(angle) * r;
    sy[li] = cy + Math.sin(angle) * r;
  });

  // 엣지를 로컬 인덱스 쌍으로 변환 (엣지 양끝은 항상 degree > 0 → sim에 존재)
  const springA = new Int32Array(edges.length);
  const springB = new Int32Array(edges.length);
  edges.forEach((e, i) => {
    springA[i] = localOf.get(e.source)!;
    springB[i] = localOf.get(e.target)!;
  });

  // 시뮬레이션 파라미터 — 이상적 간격은 "연결 구조가 차지하는 영역" 기준
  const k = Math.sqrt((width * height * areaFrac) / Math.max(m, 1));
  const repulsion = k * k; // 반발 상수
  const springLen = k * 0.8; // 엣지 자연 길이
  const springStrength = 0.02;
  const useBH = m > BH_THRESHOLD;

  const dispX = new Float64Array(m);
  const dispY = new Float64Array(m);

  for (let iter = 0; iter < iterations; iter += 1) {
    // 시간이 갈수록 이동량을 줄여(annealing) 안정화
    const cooling = 1 - iter / iterations;
    dispX.fill(0);
    dispY.fill(0);

    // 노드 간 반발 — 규모에 따라 exact/Barnes-Hut 선택
    if (useBH) {
      repulsionBH(sx, sy, m, repulsion, dispX, dispY);
    } else {
      repulsionExact(sx, sy, m, repulsion, dispX, dispY);
    }

    // 엣지 스프링 당김
    for (let i = 0; i < edges.length; i += 1) {
      const a = springA[i];
      const b = springB[i];
      const dx = sx[a] - sx[b];
      const dy = sy[a] - sy[b];
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
    for (let i = 0; i < m; i += 1) {
      dispX[i] += (cx - sx[i]) * gravity;
      dispY[i] += (cy - sy[i]) * gravity;
    }

    // 이동량 제한 + 적용. 사각 클램프는 하지 않는다 — 경계에 들러붙는
    // 왜곡을 피하고, 최종 bbox-fit(layoutGraph)이 뷰포트에 담는다.
    const maxMove = k * cooling;
    let maxDisp = 0;
    for (let i = 0; i < m; i += 1) {
      const len = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 1;
      const limited = Math.min(len, maxMove);
      sx[i] += (dispX[i] / len) * limited;
      sy[i] += (dispY[i] / len) * limited;
      if (limited > maxDisp) maxDisp = limited;
    }

    // 조기 수렴: 아무도 의미 있게 안 움직이면 남은 반복은 낭비다
    if (maxDisp < CONVERGENCE_EPS) break;
  }

  simIdx.forEach((gi, li) => {
    xs[gi] = sx[li];
    ys[gi] = sy[li];
  });
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
