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

    // 이동량 제한 + 적용 + 경계 클램프
    const maxMove = k * cooling;
    for (let i = 0; i < n; i += 1) {
      const len = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 1;
      const limited = Math.min(len, maxMove);
      xs[i] += (dispX[i] / len) * limited;
      ys[i] += (dispY[i] / len) * limited;
      const pad = 24;
      xs[i] = Math.max(pad, Math.min(width - pad, xs[i]));
      ys[i] = Math.max(pad, Math.min(height - pad, ys[i]));
    }
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
