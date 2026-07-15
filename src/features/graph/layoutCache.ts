// 그래프 레이아웃 세션 캐시 (P4).
// 그래프 내용(노드+엣지)이 같으면 layoutGraph는 항상 같은 결과를 주므로,
// 서명이 일치하는 동안 마지막 레이아웃을 재사용한다 — 그래프뷰를 다시 열 때
// 즉시 표시되고, StrictMode(dev)의 이중 useMemo 호출도 한 번만 계산한다.
// 노트가 바뀌면 백엔드가 다른 그래프를 주고 서명이 달라져 자연히 무효화된다.

import type { LinkGraph } from "../../ipc/types";
import type { GraphLayout } from "./layout";

/** FNV-1a 64비트(2×32비트) 해시로 그래프 내용 서명을 만든다. 결정적. */
export function graphSignature(graph: LinkGraph): string {
  let h1 = 2166136261;
  let h2 = 40389;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 2246822519);
    }
    // 필드 구분자 — "ab"+"c"와 "a"+"bc"가 같은 서명이 되지 않게
    h1 = Math.imul(h1 ^ 0x1f, 16777619);
    h2 = Math.imul(h2 ^ 0x1f, 2246822519);
  };
  for (const n of graph.nodes) mix(n.path);
  for (const e of graph.edges) {
    mix(e.source);
    mix(e.target);
  }
  return `${graph.nodes.length}:${graph.edges.length}:${h1 >>> 0}:${h2 >>> 0}`;
}

// 모달은 한 번에 하나만 뜨므로 마지막 1건이면 충분하다.
let last: { sig: string; layout: GraphLayout } | null = null;

export function getCachedLayout(sig: string): GraphLayout | null {
  return last && last.sig === sig ? last.layout : null;
}

export function setCachedLayout(sig: string, layout: GraphLayout): void {
  last = { sig, layout };
}

/** 테스트 전용: 캐시를 비운다. */
export function clearLayoutCache(): void {
  last = null;
}
