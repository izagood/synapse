// 스트레스 벤치마크 — CI에서는 돌지 않는다 (STRESS=1 지정 시에만 실행).
//   STRESS=1 npx vitest run src/features/graph/layout.stress.test.ts --silent=false
// 10k/50k/100k 노드 규모에서 computeGraph(TS 스캔 미러) + filterGraph +
// layoutGraph 소요 시간을 측정한다. 브라우저 실구동은 vite dev 에서
// `?mockNotes=100000` 파라미터(src/ipc/mock.ts 합성 볼트)로 재현한다.
// 2026-07-15 실측(M계열 mac, node): 스캔·필터는 100k에서도 밀리초,
// 레이아웃이 병목 — 10k≈1s / 50k≈8.4s / 100k≈22.5s.
import { describe, expect, it } from "vitest";
import type { LinkGraph } from "../../ipc/types";
import { GRAPH_VIEW_DEFAULTS } from "../../stores/graphView";
import { filterGraph, visibleGraph } from "./filter";
import { layoutGraph } from "./layout";
import { computeGraph } from "../editor/backlinks";

const ROOT = "/stress";

function synthFiles(n: number): Map<string, string> {
  const files = new Map<string, string>();
  const clusters = Math.min(200, n);
  for (let c = 0; c < clusters; c += 1) {
    files.set(`${ROOT}/hubs/hub-${c}.md`, `# hub-${c}\n\n#cluster${c % 40}`);
  }
  for (let i = 0; i < n; i += 1) {
    const c = i % clusters;
    const parts: string[] = [];
    if (i % 3 !== 0) parts.push(`[[hub-${c}]]`);
    if (i % 7 === 0) parts.push(`[[n${(i + 13) % n}]]`);
    if (i % 5 === 0) parts.push(`#topic${c % 40}`);
    files.set(`${ROOT}/c${c}/n${i}.md`, `# n${i}\n\n${parts.join(" ")}`);
  }
  return files;
}

describe.runIf(process.env.STRESS === "1")("스트레스 벤치마크", () => {
  for (const n of [10_000, 50_000, 100_000]) {
    it(`${n} 노트`, () => {
      const files = synthFiles(n);
      const t0 = performance.now();
      const graph: LinkGraph = computeGraph(ROOT, files);
      const t1 = performance.now();
      const shown = visibleGraph(graph, GRAPH_VIEW_DEFAULTS, null);
      const t2 = performance.now();
      const layout = layoutGraph(shown, { width: 900, height: 600 });
      const t3 = performance.now();
      // 고립 포함 전체도 측정
      const all = filterGraph(graph, { query: "", showTags: true, showOrphans: true });
      const t4 = performance.now();
      const layoutAll = layoutGraph(all, { width: 900, height: 600 });
      const t5 = performance.now();
      console.log(
        `[${n}] nodes=${graph.nodes.length} edges=${graph.edges.length} | ` +
          `computeGraph=${(t1 - t0).toFixed(0)}ms filter=${(t2 - t1).toFixed(0)}ms ` +
          `layout(연결만 ${shown.nodes.length})=${(t3 - t2).toFixed(0)}ms | ` +
          `filter(전체)=${(t4 - t3).toFixed(0)}ms layout(전체 ${layoutAll.nodes.length})=${(t5 - t4).toFixed(0)}ms`,
      );
      expect(layout.nodes.length).toBeGreaterThan(0);
    }, 300_000);
  }
});
