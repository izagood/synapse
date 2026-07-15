import { create } from "zustand";

// 그래프 뷰 취향(필터·그룹·표시·힘)은 기기 로컬 UI 상태다 — 앱 설정 파일이
// 아니라 localStorage에 둔다 (옵시디언도 그래프 설정을 별도 파일로 분리한다).
const STORAGE_KEY = "synapse.graphView";

export interface GraphGroup {
  id: string;
  /** 매칭 규칙: "tag:x" | "path:sub/" | 일반 문자열(이름 부분 일치) */
  query: string;
  /** CSS 색상 (#rrggbb) */
  color: string;
}

export interface GraphViewSettings {
  filters: {
    query: string;
    showTags: boolean;
    showOrphans: boolean;
    /** 0=전체 그래프, 1|2=현재 노트 중심 로컬 그래프 깊이 */
    localDepth: 0 | 1 | 2;
  };
  groups: GraphGroup[];
  display: { nodeScale: number; linkThickness: number };
  forces: { repulsion: number; linkDistance: number; gravity: number };
}

export const GRAPH_VIEW_DEFAULTS: GraphViewSettings = {
  filters: { query: "", showTags: true, showOrphans: false, localDepth: 0 },
  groups: [],
  display: { nodeScale: 1, linkThickness: 1 },
  forces: { repulsion: 1, linkDistance: 1, gravity: 1 },
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, v))
    : dflt;

/** 손상·과거 버전 localStorage 데이터를 안전한 설정으로 보정한다. */
export function normalizeGraphViewSettings(raw: unknown): GraphViewSettings {
  // 형태를 모르는 외부 데이터라 한 번 느슨하게 받은 뒤 필드별로 검증한다
  const r = (raw ?? {}) as {
    filters?: Record<string, unknown>;
    groups?: unknown;
    display?: Record<string, unknown>;
    forces?: Record<string, unknown>;
  };
  const d = GRAPH_VIEW_DEFAULTS;
  return {
    filters: {
      query:
        typeof r.filters?.query === "string" ? r.filters.query : d.filters.query,
      showTags:
        typeof r.filters?.showTags === "boolean"
          ? r.filters.showTags
          : d.filters.showTags,
      showOrphans:
        typeof r.filters?.showOrphans === "boolean"
          ? r.filters.showOrphans
          : d.filters.showOrphans,
      localDepth:
        r.filters?.localDepth === 1 || r.filters?.localDepth === 2
          ? r.filters.localDepth
          : 0,
    },
    groups: Array.isArray(r.groups)
      ? r.groups
          .filter(
            (g): g is GraphGroup =>
              typeof g === "object" &&
              g !== null &&
              typeof (g as GraphGroup).id === "string" &&
              typeof (g as GraphGroup).query === "string" &&
              typeof (g as GraphGroup).color === "string",
          )
          .map((g) => ({ id: g.id, query: g.query, color: g.color }))
      : [],
    display: {
      nodeScale: clamp(r.display?.nodeScale, 0.5, 2, 1),
      linkThickness: clamp(r.display?.linkThickness, 0.5, 3, 1),
    },
    forces: {
      repulsion: clamp(r.forces?.repulsion, 0.25, 4, 1),
      linkDistance: clamp(r.forces?.linkDistance, 0.25, 4, 1),
      gravity: clamp(r.forces?.gravity, 0.25, 4, 1),
    },
  };
}

function load(): GraphViewSettings {
  try {
    return normalizeGraphViewSettings(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return GRAPH_VIEW_DEFAULTS;
  }
}

function save(s: GraphViewSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 저장 실패(프라이빗 모드 등)해도 세션 내 동작은 계속한다
  }
}

/** 섹션 단위 부분 패치 — groups는 배열 통째 교체, 나머지는 필드 병합 */
export type GraphViewPatch = {
  filters?: Partial<GraphViewSettings["filters"]>;
  groups?: GraphGroup[];
  display?: Partial<GraphViewSettings["display"]>;
  forces?: Partial<GraphViewSettings["forces"]>;
};

interface GraphViewState {
  settings: GraphViewSettings;
  update(patch: GraphViewPatch): void;
  reset(): void;
}

export const useGraphView = create<GraphViewState>((set, get) => ({
  settings: load(),
  update(patch) {
    const cur = get().settings;
    const merged = normalizeGraphViewSettings({
      filters: { ...cur.filters, ...patch.filters },
      groups: patch.groups ?? cur.groups,
      display: { ...cur.display, ...patch.display },
      forces: { ...cur.forces, ...patch.forces },
    });
    save(merged);
    set({ settings: merged });
  },
  reset() {
    save(GRAPH_VIEW_DEFAULTS);
    set({ settings: GRAPH_VIEW_DEFAULTS });
  },
}));
