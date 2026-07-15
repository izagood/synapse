// 그래프 표시 전 서브그래프 필터링 + 그룹 컬러 매칭 (옵시디언 Filters/Groups 대응).
// 전부 순수 함수 — 레이아웃(layout.ts)에 들어가기 전의 LinkGraph를 다듬는다.
import type { GraphNode, LinkGraph } from "../../ipc/types";
import type { GraphGroup, GraphViewSettings } from "../../stores/graphView";

export interface FilterOptions {
  /** 이름 부분 일치 필터 — 일치 노드와 직접 이웃만 남긴다. 빈 문자열이면 미적용 */
  query: string;
  showTags: boolean;
  /** false면 (필터 적용 후) 연결이 없는 노트를 숨긴다 */
  showOrphans: boolean;
  /** 로컬 그래프: center 노드에서 depth 홉 이내만 남긴다 */
  local?: { center: string; depth: 1 | 2 };
}

/** 무방향 인접 리스트 (BFS·이웃 계산 공용) */
function adjacency(edges: LinkGraph["edges"]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = adj.get(a);
    if (!set) {
      set = new Set();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  return adj;
}

/** keep 집합에 든 노드·양끝이 모두 든 엣지만 남긴다 */
function subgraph(nodes: GraphNode[], edges: LinkGraph["edges"], keep: Set<string>) {
  return {
    nodes: nodes.filter((n) => keep.has(n.path)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/**
 * 설정에 따라 표시할 서브그래프를 만든다. 적용 순서가 의미를 가진다:
 * 태그 제거 → 로컬 그래프 → 검색 필터 → 고립 숨김 (고립 여부는 앞 단계
 * 필터가 끝난 뒤의 연결 기준으로 판단한다).
 */
export function filterGraph(graph: LinkGraph, opts: FilterOptions): LinkGraph {
  let nodes = graph.nodes;
  let edges = graph.edges;

  if (!opts.showTags) {
    nodes = nodes.filter((n) => n.kind !== "tag");
    const alive = new Set(nodes.map((n) => n.path));
    edges = edges.filter((e) => alive.has(e.source) && alive.has(e.target));
  }

  if (opts.local) {
    const adj = adjacency(edges);
    const keep = new Set<string>([opts.local.center]);
    let frontier = [opts.local.center];
    for (let hop = 0; hop < opts.local.depth; hop += 1) {
      const next: string[] = [];
      for (const p of frontier) {
        for (const q of adj.get(p) ?? []) {
          if (!keep.has(q)) {
            keep.add(q);
            next.push(q);
          }
        }
      }
      frontier = next;
    }
    ({ nodes, edges } = subgraph(nodes, edges, keep));
  }

  const q = opts.query.trim().toLowerCase();
  if (q) {
    const matched = new Set(
      nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.path),
    );
    const adj = adjacency(edges);
    const keep = new Set(matched);
    for (const p of matched) for (const nb of adj.get(p) ?? []) keep.add(nb);
    ({ nodes, edges } = subgraph(nodes, edges, keep));
  }

  if (!opts.showOrphans) {
    const deg = new Map<string, number>();
    for (const e of edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    // 태그 노드는 항상 엣지에서 태어나므로 이 규칙은 사실상 노트에만 작용한다
    nodes = nodes.filter((n) => (deg.get(n.path) ?? 0) > 0);
  }

  return { nodes, edges };
}

/**
 * GraphView 파이프라인: 설정 → 표시용 서브그래프.
 * 로컬 그래프는 activePath가 실제 그래프에 있을 때만 적용한다 —
 * 노트를 안 연 상태나 그래프 밖 파일이 활성인 경우 전체 그래프를 유지한다.
 */
export function visibleGraph(
  graph: LinkGraph,
  s: GraphViewSettings,
  activePath: string | null,
): LinkGraph {
  const depth = s.filters.localDepth;
  const local =
    depth !== 0 && activePath && graph.nodes.some((n) => n.path === activePath)
      ? { center: activePath, depth }
      : undefined;
  return filterGraph(graph, {
    query: s.filters.query,
    showTags: s.filters.showTags,
    showOrphans: s.filters.showOrphans,
    local,
  });
}

/** 노트 path → 연결된 태그 집합("#x"). 그룹 tag: 규칙 매칭용 */
export function buildTagIndex(graph: LinkGraph): Map<string, Set<string>> {
  const tagPaths = new Set(
    graph.nodes.filter((n) => n.kind === "tag").map((n) => n.path),
  );
  const idx = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!tagPaths.has(e.target)) continue;
    let set = idx.get(e.source);
    if (!set) {
      set = new Set();
      idx.set(e.source, set);
    }
    set.add(e.target);
  }
  return idx;
}

/**
 * 그룹 매칭 — 첫 일치 그룹의 색을 돌려준다 (옵시디언과 같은 선착순 우선).
 * 규칙: "tag:x"(#x 태그 보유 노트·#x 노드 자신) | "path:p"(경로 부분 일치) |
 * 그 외 문자열(이름 부분 일치, 대소문자 무시)
 */
export function groupColorOf(
  node: GraphNode,
  groups: GraphGroup[],
  tagIndex: Map<string, Set<string>>,
): string | null {
  for (const g of groups) {
    const raw = g.query.trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.startsWith("tag:")) {
      const tag = `#${lower.slice(4).replace(/^#/, "")}`;
      if (node.path === tag || tagIndex.get(node.path)?.has(tag)) return g.color;
    } else if (lower.startsWith("path:")) {
      if (node.path.toLowerCase().includes(lower.slice(5))) return g.color;
    } else if (node.name.toLowerCase().includes(lower)) {
      return g.color;
    }
  }
  return null;
}
