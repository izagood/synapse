# 그래프 뷰 v2 (옵시디언 벤치마킹) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 옵시디언 그래프 뷰를 벤치마킹해 synapse 그래프에 태그 노드·그룹 컬러링·설정 패널(Filters/Groups/Display/Forces)·로컬 그래프를 추가한다.

**Architecture:** Rust 코어(`links.rs`)가 태그를 노드로 승격해 그래프 페이로드를 확장하고, 프론트는 순수 함수(필터·그룹 매칭·파라미터화 레이아웃) + zustand 스토어 + 접이식 설정 패널로 구성한다. 기존 결정적 force 레이아웃과 레이아웃 캐시는 유지하되 Forces 파라미터만 캐시 키에 포함한다.

**Tech Stack:** Rust(synapse-core, cargo test) · React + zustand + SVG(vitest) · Ladle(UI 확인)

## 배경 — 제품 비전 (기록)

synapse는 이름처럼 **노트들이 뉴런처럼 연결되는 "제2의 뇌"**를 지향한다. 그래프 뷰는 옵시디언을 벤치마킹하되, 차별점은 **AI-native**다: agent가 노트를 생성하고 그래프를 연결하며(1차 구현: `feat/auto-links`의 `link_candidates`/`apply_links` MCP 도구), **사용자는 온전히 노트를 사용하는 데만 집중**한다. 이 계획은 그 비전의 "보는 축" — 연결된 뇌를 탐색하는 그래프 경험 — 을 강화한다.

벤치마킹 근거 (옵시디언 스크린샷 8장 분석):

| 옵시디언 기능 | 현재 synapse | 이 계획 |
|---|---|---|
| 태그가 허브 노드로 참여해 클러스터 형성 | 없음 (노드=노트만) | Task 1–2 |
| 검색 쿼리 기반 그룹 컬러링 | 없음 (단색) | Task 4, 7 |
| Filters/Groups/Display/Forces 설정 패널 | 없음 | Task 3, 6 |
| Forces 슬라이더로 레이아웃 조정 | 고정 파라미터 | Task 5 |
| 고립 노트 표시 토글 | 항상 숨김 (degree 0 미렌더) | Task 4, 7 |
| 로컬 그래프 (현재 노트 중심 깊이 제한) | 없음 | Task 4, 7 |
| 호버 시 이웃만 강조·나머지 딤 | **이미 있음** | 유지 |
| 줌 레벨 연동 라벨 밀도 | **이미 있음** | 유지 |

## Global Constraints

- 베이스 브랜치: `main` (그래프 레이아웃 4단 성능 개선을 담은 perf/graph-view가 PR #144로 머지 완료된 상태 기준).
- 외부 그래프 라이브러리(d3 등) 추가 금지 — 기존 방침 유지.
- 레이아웃은 결정적이어야 한다(난수 금지): 같은 입력 + 같은 파라미터 → 같은 좌표.
- 라벨 폭 추정 등 CJK(한글) 텍스트 처리 경로를 깨지 말 것.
- 기능마다 테스트 동반 (TS: vitest `*.test.ts`, Rust: `crates/synapse-core` 단위 테스트). 순수 UI는 Ladle 스토리 + PR 본문에 수동 검증 기록 (CLAUDE.md 컨벤션).
- 푸시 전 로컬 게이트: `npm run typecheck && npm test && npm run build`, Rust 변경 시 `cargo test`(crates/synapse-core에서) / `cargo check`(src-tauri에서).
- i18n: 사용자 노출 문자열은 `src/i18n/locales/ko.ts`·`en.ts` 두 곳 모두 추가.
- 커밋 메시지는 저장소 관례(한국어 Conventional Commits: `feat(graph): …`).

## 결정 포인트 (구현 전 확인)

1. **태그 대소문자**: `#AI`와 `#ai`는 같은 태그로 본다(소문자 정규화, 옵시디언과 동일). 표시명도 소문자.
2. **그래프 설정 저장 위치**: 앱 설정 파일(ipc settings)이 아닌 **localStorage** — 그래프 뷰 취향은 기기 로컬 UI 상태이고, settings 스키마 마이그레이션 부담을 피한다. 옵시디언도 그래프 설정을 별도(graph.json)로 둔다.
3. **프론트마터 태그**: 이번 범위 제외(인라인 `#tag`만). 코드 펜스 내부 태그는 제외, 인라인 코드(`` ` ``) 내부는 허용(알려진 한계로 문서화).

---

### Task 1: Rust — 인라인 태그 추출 + 그래프에 태그 노드 승격

**Files:**
- Modify: `crates/synapse-core/src/links.rs` (GraphNode에 kind 추가, extract_tags 신설, ScanEntry·build_graph_cached 확장, 테스트)

**Interfaces:**
- Produces: `pub enum NodeKind { Note, Tag }` (serde: `"note"`/`"tag"`), `GraphNode { path, name, kind }`, `pub fn extract_tags(content: &str) -> Vec<String>` (소문자, 파일 내 중복 제거, 등장 순). 태그 노드는 `path = name = "#<tag소문자>"`, 엣지는 노트→태그 방향.

- [ ] **Step 1: 실패하는 테스트 작성** — `links.rs` 테스트 모듈에 추가:

```rust
#[test]
fn extract_tags_inline() {
    let body = "노트 정리 #AI #machine-learning 참고\n\
                # 마크다운 헤딩은 태그가 아니다\n\
                이슈 #123 은 숫자라 제외\n\
                ```\n#펜스-내부-제외\n```\n\
                괄호(#nested) http://x.com/#anchor #AI";
    assert_eq!(extract_tags(body), vec!["ai", "machine-learning", "nested"]);
}

#[test]
fn build_graph_promotes_tags_to_nodes() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("a.md"), "#AI 관련 [[b]]").unwrap();
    std::fs::write(tmp.path().join("b.md"), "#ai 후속").unwrap();
    let g = build_graph(tmp.path()).unwrap();

    let tag: Vec<_> = g.nodes.iter().filter(|n| n.kind == NodeKind::Tag).collect();
    assert_eq!(tag.len(), 1, "#AI/#ai 는 같은 태그 노드 하나");
    assert_eq!(tag[0].path, "#ai");
    assert_eq!(tag[0].name, "#ai");
    assert!(g.nodes.iter().all(|n| n.kind == NodeKind::Tag || n.kind == NodeKind::Note));
    // 노트→태그 엣지 2개 (a→#ai, b→#ai)
    let tag_edges: Vec<_> = g.edges.iter().filter(|e| e.target == "#ai").collect();
    assert_eq!(tag_edges.len(), 2);
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd crates/synapse-core && cargo test extract_tags_inline build_graph_promotes_tags -- --nocapture`
Expected: FAIL — `extract_tags`, `NodeKind` 미정의 컴파일 에러.

- [ ] **Step 3: 구현**

`GraphNode`/`NodeKind` (기존 GraphNode 정의 교체, 위치 `links.rs:325` 부근):

```rust
/// 그래프 노드 종류 — 노트 파일이거나, 본문에서 추출한 해시태그 허브.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Note,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// 노트 절대 경로, 태그 노드는 "#<tag>" (안정적 식별자)
    pub path: String,
    /// 표시용 이름 (태그 노드는 "#<tag>")
    pub name: String,
    pub kind: NodeKind,
}
```

`extract_tags` (모듈 레벨, `is_markdown` 근처):

```rust
/// 본문의 인라인 해시태그를 추출한다 (소문자 정규화·파일 내 중복 제거·등장 순).
///
/// 규칙 (옵시디언 태그 문법 근사):
/// - `#` 뒤에 태그 문자(유니코드 글자·숫자·`-`·`_`·`/`)가 1자 이상.
/// - `#` 앞은 행 시작·공백·여는 괄호류여야 한다 — 헤딩(`# 제목`)은 뒤가
///   공백이라, URL 조각(`…/#anchor`)은 앞이 `/`라 자연히 제외된다.
/// - 숫자로만 된 토큰(`#123`)은 이슈 번호로 보고 제외한다.
/// - 코드 펜스(``` / ~~~) 내부는 건너뛴다. 인라인 코드 내부는 허용(알려진 한계).
pub fn extract_tags(content: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut in_fence = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '#' {
                i += 1;
                continue;
            }
            let boundary_ok = i == 0
                || chars[i - 1].is_whitespace()
                || matches!(chars[i - 1], '(' | '[' | '{');
            let mut j = i + 1;
            while j < chars.len() && is_tag_char(chars[j]) {
                j += 1;
            }
            if boundary_ok && j > i + 1 {
                let tag: String = chars[i + 1..j].iter().collect::<String>().to_lowercase();
                if !tag.chars().all(|c| c.is_ascii_digit()) && seen.insert(tag.clone()) {
                    tags.push(tag);
                }
            }
            i = j.max(i + 1);
        }
    }
    tags
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '/')
}
```

`ScanEntry`에 태그 캐시 추가 + `build_graph_cached` 확장:

```rust
struct ScanEntry {
    mtime: std::time::SystemTime,
    len: u64,
    links: Vec<OutLink>,
    tags: Vec<String>,
}
```

`build_graph_cached` 안에서 (1) 노트 노드 생성 시 `kind: NodeKind::Note` 지정, (2) 캐시 미스 분기에서 `let tags = extract_tags(&body);`를 함께 저장, (3) 엣지 정렬 **직전**에 태그 노드·엣지 합류:

```rust
// 태그 허브: 각 노트의 인라인 태그를 노드로 승격하고 노트→태그 엣지를 잇는다.
let mut tag_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
for source in &md_files {
    let Some(entry) = cache.entries.get(source) else { continue };
    for tag in &entry.tags {
        let id = format!("#{tag}");
        tag_ids.insert(id.clone());
        edges.push(GraphEdge {
            source: source.display().to_string(),
            target: id,
        });
    }
}
let mut nodes = nodes;
for id in tag_ids {
    nodes.push(GraphNode { path: id.clone(), name: id, kind: NodeKind::Tag });
}
```

(정렬 `edges.sort_by(...)`는 합류 뒤에 실행되도록 위치 이동. `extract_tags`가 파일 내 중복을 제거하므로 (source, tag) 엣지는 이미 유일하다.)

- [ ] **Step 4: 테스트 통과 + 기존 테스트 회귀 확인**

Run: `cd crates/synapse-core && cargo test`
Expected: 신규 2개 포함 전부 PASS. (기존 build_graph 테스트가 노드 수를 단언하면 태그 노드만큼 보정.)

- [ ] **Step 5: 커밋**

```bash
git add crates/synapse-core/src/links.rs
git commit -m "feat(core): 그래프에 인라인 태그를 허브 노드로 승격 — extract_tags + GraphNode.kind"
```

---

### Task 2: IPC 타입·mock 동기화 (TS)

**Files:**
- Modify: `src/ipc/types.ts:216-234` (GraphNode에 kind), `src/ipc/mock.ts:367-370` (mock linkGraph에 태그 합성)
- Test: `src/ipc/mock.test.ts` (기존 파일 있으면 추가, 없으면 신설)

**Interfaces:**
- Produces: `type NodeKind = "note" | "tag"`, `GraphNode.kind: NodeKind` — Task 4·7이 소비. mock 헬퍼 `withMockTags(g: LinkGraph, files: Map<string, string>): LinkGraph`.

- [ ] **Step 1: 실패하는 테스트 작성** — `src/ipc/mock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mockIpc } from "./mock";

describe("mock linkGraph 태그", () => {
  it("본문 #태그를 tag 노드로 승격한다", async () => {
    const g = await mockIpc.linkGraph("/mock");
    const tags = g.nodes.filter((n) => n.kind === "tag");
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((n) => n.path.startsWith("#"))).toBe(true);
    // 모든 노트 노드는 kind가 명시돼 있다
    expect(g.nodes.every((n) => n.kind === "tag" || n.kind === "note")).toBe(true);
  });
});
```

(mock의 export 이름이 `mockIpc`가 아니면 `mock.ts`의 실제 export를 따른다. mock 픽스처 노트 중 하나에 `#demo` 태그가 없으면 픽스처 본문에 한 줄 추가한다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ipc/mock.test.ts`
Expected: FAIL — `kind` 프로퍼티 없음(타입 에러 또는 undefined).

- [ ] **Step 3: 구현**

`types.ts` — Rust와 1:1 대응 갱신:

```ts
/** Rust synapse-core::links::NodeKind 와 1:1 대응 */
export type NodeKind = "note" | "tag";

export interface GraphNode {
  /** 노트 절대 경로, 태그 노드는 "#<tag>" (안정적 식별자) */
  path: string;
  /** 표시용 이름 (태그 노드는 "#<tag>") */
  name: string;
  kind: NodeKind;
}
```

`mock.ts` — computeGraph 결과에 태그 합성 (Rust extract_tags의 단순 근사):

```ts
/** mock 전용: 본문 인라인 #태그를 tag 노드·엣지로 합성 (Rust extract_tags 근사) */
function withMockTags(g: LinkGraph, files: Map<string, string>): LinkGraph {
  const tagRe = /(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu;
  const nodes = g.nodes.map((n) => ({ ...n, kind: "note" as const }));
  const edges = [...g.edges];
  const tagIds = new Set<string>();
  for (const [path, body] of files) {
    if (!/\.(md|markdown)$/i.test(path)) continue;
    const seen = new Set<string>();
    for (const m of body.matchAll(tagRe)) {
      const tag = m[2].toLowerCase();
      if (/^\d+$/.test(tag) || seen.has(tag)) continue;
      seen.add(tag);
      const id = `#${tag}`;
      tagIds.add(id);
      edges.push({ source: `${MOCK_ROOT}/${path}`, target: id });
    }
  }
  for (const id of [...tagIds].sort()) {
    nodes.push({ path: id, name: id, kind: "tag" });
  }
  return { nodes, edges };
}
```

`linkGraph` 핸들러를 `return withMockTags(computeGraph(MOCK_ROOT, files), files);`로 교체. (mock 내 노트 경로 키 형태가 `MOCK_ROOT` 포함이면 `${MOCK_ROOT}/` 접두를 중복하지 않게 computeGraph의 노드 path 생성 방식과 맞춘다.)

- [ ] **Step 4: 통과 확인 + 타입체크**

Run: `npx vitest run src/ipc/mock.test.ts && npm run typecheck`
Expected: PASS. typecheck에서 `GraphView.tsx` 등 기존 코드는 kind를 아직 안 읽으므로 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/ipc/types.ts src/ipc/mock.ts src/ipc/mock.test.ts
git commit -m "feat(ipc): GraphNode.kind(note|tag) 타입·mock 태그 합성 동기화"
```

---

### Task 3: 그래프 뷰 설정 스토어 (zustand + localStorage)

**Files:**
- Create: `src/stores/graphView.ts`
- Test: `src/stores/graphView.test.ts`

**Interfaces:**
- Produces (Task 6·7이 소비):

```ts
export interface GraphGroup { id: string; query: string; color: string }
export interface GraphViewSettings {
  filters: { query: string; showTags: boolean; showOrphans: boolean; localDepth: 0 | 1 | 2 };
  groups: GraphGroup[];
  display: { nodeScale: number; linkThickness: number };  // 0.5–2 / 0.5–3
  forces: { repulsion: number; linkDistance: number; gravity: number }; // 각 0.25–4, 기본 1
}
export const GRAPH_VIEW_DEFAULTS: GraphViewSettings;
export function normalizeGraphViewSettings(raw: unknown): GraphViewSettings; // 손상·과거 데이터 보정
export const useGraphView: /* zustand */ {
  settings: GraphViewSettings;
  update(patch: DeepPartial<GraphViewSettings>): void; // 병합 + localStorage 저장
  reset(): void;
};
```

- [ ] **Step 1: 실패하는 테스트 작성** — `src/stores/graphView.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  GRAPH_VIEW_DEFAULTS,
  normalizeGraphViewSettings,
  useGraphView,
} from "./graphView";

beforeEach(() => {
  localStorage.clear();
  useGraphView.getState().reset();
});

describe("graphView 설정 스토어", () => {
  it("기본값: 태그 표시, 고립 숨김, 배율 1", () => {
    const s = useGraphView.getState().settings;
    expect(s.filters).toEqual({ query: "", showTags: true, showOrphans: false, localDepth: 0 });
    expect(s.forces).toEqual({ repulsion: 1, linkDistance: 1, gravity: 1 });
  });

  it("부분 패치가 병합되고 localStorage에 저장된다", () => {
    useGraphView.getState().update({ filters: { showOrphans: true } });
    expect(useGraphView.getState().settings.filters.showOrphans).toBe(true);
    expect(useGraphView.getState().settings.filters.showTags).toBe(true); // 기존 값 유지
    const raw = JSON.parse(localStorage.getItem("synapse.graphView")!);
    expect(raw.filters.showOrphans).toBe(true);
  });

  it("normalize: 손상 데이터는 기본값으로, 범위 밖 배율은 클램프", () => {
    expect(normalizeGraphViewSettings(null)).toEqual(GRAPH_VIEW_DEFAULTS);
    const s = normalizeGraphViewSettings({ forces: { repulsion: 99 } });
    expect(s.forces.repulsion).toBe(4);
    expect(s.forces.linkDistance).toBe(1);
  });

  it("reset은 기본값 복원 + 저장", () => {
    useGraphView.getState().update({ display: { nodeScale: 2 } });
    useGraphView.getState().reset();
    expect(useGraphView.getState().settings).toEqual(GRAPH_VIEW_DEFAULTS);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/stores/graphView.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/stores/graphView.ts`:

```ts
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
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** 손상·과거 버전 localStorage 데이터를 안전한 설정으로 보정한다. */
export function normalizeGraphViewSettings(raw: unknown): GraphViewSettings {
  const r = (raw ?? {}) as Record<string, any>;
  const d = GRAPH_VIEW_DEFAULTS;
  return {
    filters: {
      query: typeof r.filters?.query === "string" ? r.filters.query : d.filters.query,
      showTags: typeof r.filters?.showTags === "boolean" ? r.filters.showTags : d.filters.showTags,
      showOrphans:
        typeof r.filters?.showOrphans === "boolean" ? r.filters.showOrphans : d.filters.showOrphans,
      localDepth: r.filters?.localDepth === 1 || r.filters?.localDepth === 2 ? r.filters.localDepth : 0,
    },
    groups: Array.isArray(r.groups)
      ? r.groups
          .filter(
            (g: any) =>
              typeof g?.id === "string" && typeof g?.query === "string" && typeof g?.color === "string",
          )
          .map((g: any) => ({ id: g.id, query: g.query, color: g.color }))
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
    return normalizeGraphViewSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return GRAPH_VIEW_DEFAULTS;
  }
}

function save(s: GraphViewSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 저장 실패(사파리 프라이빗 모드 등)해도 동작은 계속한다
  }
}

type Patch = {
  [K in keyof GraphViewSettings]?: GraphViewSettings[K] extends object
    ? Partial<GraphViewSettings[K]>
    : GraphViewSettings[K];
};

interface GraphViewState {
  settings: GraphViewSettings;
  update(patch: Patch): void;
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/stores/graphView.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/stores/graphView.ts src/stores/graphView.test.ts
git commit -m "feat(graph): 그래프 뷰 설정 스토어 — 필터·그룹·표시·힘, localStorage 영속"
```

---

### Task 4: 서브그래프 필터·그룹 매칭 순수 함수

**Files:**
- Create: `src/features/graph/filter.ts`
- Test: `src/features/graph/filter.test.ts`

**Interfaces:**
- Consumes: `LinkGraph`/`GraphNode.kind`(Task 2), `GraphGroup`(Task 3)
- Produces (Task 7이 소비):

```ts
export interface FilterOptions {
  query: string; showTags: boolean; showOrphans: boolean;
  local?: { center: string; depth: 1 | 2 };
}
export function filterGraph(graph: LinkGraph, opts: FilterOptions): LinkGraph;
export function buildTagIndex(graph: LinkGraph): Map<string, Set<string>>; // 노트 path → 태그 집합("#x")
export function groupColorOf(
  node: GraphNode, groups: GraphGroup[], tagIndex: Map<string, Set<string>>,
): string | null; // 첫 일치 그룹 색, 없으면 null
```

- [ ] **Step 1: 실패하는 테스트 작성** — `src/features/graph/filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LinkGraph } from "../../ipc/types";
import { buildTagIndex, filterGraph, groupColorOf } from "./filter";

const g: LinkGraph = {
  nodes: [
    { path: "/w/a.md", name: "a.md", kind: "note" },
    { path: "/w/b.md", name: "b.md", kind: "note" },
    { path: "/w/sub/c.md", name: "c.md", kind: "note" },
    { path: "/w/orphan.md", name: "orphan.md", kind: "note" },
    { path: "#ai", name: "#ai", kind: "tag" },
  ],
  edges: [
    { source: "/w/a.md", target: "/w/b.md" },
    { source: "/w/b.md", target: "/w/sub/c.md" },
    { source: "/w/a.md", target: "#ai" },
  ],
};

describe("filterGraph", () => {
  it("showTags=false면 태그 노드·그 엣지를 제거한다", () => {
    const f = filterGraph(g, { query: "", showTags: false, showOrphans: true });
    expect(f.nodes.some((n) => n.kind === "tag")).toBe(false);
    expect(f.edges.some((e) => e.target === "#ai")).toBe(false);
  });

  it("showOrphans=false면 필터 후 degree 0 노트를 제거한다", () => {
    const f = filterGraph(g, { query: "", showTags: true, showOrphans: false });
    expect(f.nodes.map((n) => n.path)).not.toContain("/w/orphan.md");
  });

  it("query는 이름 부분 일치 노드 + 그 이웃만 남긴다", () => {
    const f = filterGraph(g, { query: "a.md", showTags: true, showOrphans: true });
    const paths = f.nodes.map((n) => n.path);
    expect(paths).toContain("/w/a.md");
    expect(paths).toContain("/w/b.md"); // a의 이웃
    expect(paths).not.toContain("/w/sub/c.md"); // 2단계 밖
  });

  it("local: center에서 depth 1이면 직접 이웃까지만", () => {
    const f = filterGraph(g, {
      query: "", showTags: true, showOrphans: true,
      local: { center: "/w/a.md", depth: 1 },
    });
    const paths = f.nodes.map((n) => n.path).sort();
    expect(paths).toEqual(["#ai", "/w/a.md", "/w/b.md"]);
  });

  it("local depth 2면 이웃의 이웃까지", () => {
    const f = filterGraph(g, {
      query: "", showTags: true, showOrphans: true,
      local: { center: "/w/a.md", depth: 2 },
    });
    expect(f.nodes.map((n) => n.path)).toContain("/w/sub/c.md");
  });
});

describe("groupColorOf", () => {
  const tagIndex = buildTagIndex(g);
  it("tag: 규칙은 해당 태그를 가진 노트와 태그 노드 자신에 일치", () => {
    const groups = [{ id: "1", query: "tag:ai", color: "#ff0000" }];
    expect(groupColorOf(g.nodes[0], groups, tagIndex)).toBe("#ff0000"); // a.md는 #ai 보유
    expect(groupColorOf(g.nodes[4], groups, tagIndex)).toBe("#ff0000"); // #ai 노드 자신
    expect(groupColorOf(g.nodes[1], groups, tagIndex)).toBeNull();
  });

  it("path: 규칙은 경로 접두/부분 일치, 일반 문자열은 이름 부분 일치, 첫 일치 우선", () => {
    const groups = [
      { id: "1", query: "path:sub/", color: "#00ff00" },
      { id: "2", query: "c.md", color: "#0000ff" },
    ];
    expect(groupColorOf(g.nodes[2], groups, tagIndex)).toBe("#00ff00"); // path 규칙이 먼저
    expect(groupColorOf(g.nodes[0], groups, tagIndex)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/features/graph/filter.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/features/graph/filter.ts`:

```ts
// 그래프 표시 전 서브그래프 필터링 + 그룹 컬러 매칭 (옵시디언 Filters/Groups 대응).
// 전부 순수 함수 — 레이아웃(layout.ts)에 들어가기 전의 LinkGraph를 다듬는다.
import type { GraphNode, LinkGraph } from "../../ipc/types";
import type { GraphGroup } from "../../stores/graphView";

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
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  return adj;
}

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
    nodes = nodes.filter((n) => keep.has(n.path));
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }

  const q = opts.query.trim().toLowerCase();
  if (q) {
    const matched = new Set(
      nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.path),
    );
    const adj = adjacency(edges);
    const keep = new Set(matched);
    for (const p of matched) for (const nb of adj.get(p) ?? []) keep.add(nb);
    nodes = nodes.filter((n) => keep.has(n.path));
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
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

/** 노트 path → 연결된 태그 집합("#x"). 그룹 tag: 규칙 매칭용 */
export function buildTagIndex(graph: LinkGraph): Map<string, Set<string>> {
  const tagPaths = new Set(graph.nodes.filter((n) => n.kind === "tag").map((n) => n.path));
  const idx = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!tagPaths.has(e.target)) continue;
    if (!idx.has(e.source)) idx.set(e.source, new Set());
    idx.get(e.source)!.add(e.target);
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
    if (raw.toLowerCase().startsWith("tag:")) {
      const tag = `#${raw.slice(4).replace(/^#/, "").toLowerCase()}`;
      if (node.path === tag || tagIndex.get(node.path)?.has(tag)) return g.color;
    } else if (raw.toLowerCase().startsWith("path:")) {
      if (node.path.toLowerCase().includes(raw.slice(5).toLowerCase())) return g.color;
    } else if (node.name.toLowerCase().includes(raw.toLowerCase())) {
      return g.color;
    }
  }
  return null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/features/graph/filter.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/filter.ts src/features/graph/filter.test.ts
git commit -m "feat(graph): 서브그래프 필터(태그·고립·검색·로컬)와 그룹 컬러 매칭 순수 함수"
```

---

### Task 5: 레이아웃 Forces 파라미터화

**Files:**
- Modify: `src/features/graph/layout.ts:31-36` (LayoutOptions), `:434-438`(simulate 파라미터), `layoutGraph` 시그니처 전달부
- Modify: `src/features/graph/layoutCache.ts` (키에 파라미터 포함은 호출부 책임 — 변경 없음 확인만)
- Test: `src/features/graph/layout.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: `forces` 값(Task 3)
- Produces: `LayoutOptions`에 `repulsionScale?: number; linkDistanceScale?: number; gravityScale?: number` (기본 1). Task 7이 `layoutGraph(g, { width, height, repulsionScale, ... })`로 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `layout.test.ts`에 추가:

```ts
describe("forces 파라미터", () => {
  const g: LinkGraph = {
    nodes: [
      { path: "/a.md", name: "a.md", kind: "note" },
      { path: "/b.md", name: "b.md", kind: "note" },
      { path: "/c.md", name: "c.md", kind: "note" },
    ],
    edges: [
      { source: "/a.md", target: "/b.md" },
      { source: "/b.md", target: "/c.md" },
    ],
  };

  it("같은 파라미터면 결정적", () => {
    const l1 = layoutGraph(g, { repulsionScale: 2 });
    const l2 = layoutGraph(g, { repulsionScale: 2 });
    expect(l1.nodes).toEqual(l2.nodes);
  });

  it("linkDistanceScale을 키우면 연결 노드 간 거리가 늘어난다", () => {
    const dist = (l: GraphLayout, a: string, b: string) => {
      const na = l.nodes.find((n) => n.path === a)!;
      const nb = l.nodes.find((n) => n.path === b)!;
      return Math.hypot(na.x - nb.x, na.y - nb.y);
    };
    const near = layoutGraph(g, { linkDistanceScale: 0.25 });
    const far = layoutGraph(g, { linkDistanceScale: 4 });
    expect(dist(far, "/a.md", "/b.md")).toBeGreaterThan(dist(near, "/a.md", "/b.md"));
  });

  it("기본값(1)은 파라미터 미지정과 동일 좌표", () => {
    expect(layoutGraph(g, { repulsionScale: 1, linkDistanceScale: 1, gravityScale: 1 }).nodes)
      .toEqual(layoutGraph(g).nodes);
  });
});
```

(기존 테스트 파일의 import에 `GraphLayout` 추가. `kind` 필드는 Task 2 이후 LinkGraph 픽스처에 필수다 — 이 파일의 기존 픽스처에도 `kind: "note"`를 일괄 추가한다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/features/graph/layout.test.ts`
Expected: FAIL — `repulsionScale` 타입 에러.

- [ ] **Step 3: 구현**

`LayoutOptions` 확장:

```ts
export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  /** 반발력 배율 (기본 1). 클수록 노드가 넓게 퍼진다 */
  repulsionScale?: number;
  /** 엣지 자연 길이 배율 (기본 1) */
  linkDistanceScale?: number;
  /** 중심 중력 배율 (기본 1). 클수록 그래프가 조밀해진다 */
  gravityScale?: number;
}
```

`layoutGraph` → `simulate` 호출에 `opts` 전달, `simulate` 내부 상수 3곳을 배율 적용으로 교체:

```ts
const repulsion = k * k * (opts.repulsionScale ?? 1);
const springLen = k * 0.8 * (opts.linkDistanceScale ?? 1);
// ...
const gravity = 0.01 * (opts.gravityScale ?? 1);
```

(`simulate` 시그니처는 `areaFrac, iterationsOpt` 대신 `areaFrac, opts: LayoutOptions`를 받도록 바꾸고 `iterations`는 `opts.iterations ?? adaptiveIterations(m)`로.)

- [ ] **Step 4: 통과 확인 (전체 레이아웃 테스트 회귀 포함)**

Run: `npx vitest run src/features/graph/ && npm run typecheck`
Expected: PASS — BH/exact 대조 테스트 등 기존 것 포함 전부.

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/layout.ts src/features/graph/layout.test.ts
git commit -m "feat(graph): 레이아웃 forces 파라미터화 — 반발·링크 거리·중력 배율"
```

---

### Task 6: 설정 패널 UI (Filters / Groups / Display / Forces)

**Files:**
- Create: `src/features/graph/GraphPanel.tsx`, `src/features/graph/GraphPanel.stories.tsx`
- Modify: `src/app/styles.css` (그래프 패널 스타일 — 기존 `graph-*` 클래스 블록 근처), `src/i18n/locales/ko.ts:324-335`·`en.ts:330-341` (graph 섹션 키 추가)

**Interfaces:**
- Consumes: `useGraphView`(Task 3)
- Produces: `<GraphPanel />` — 프롭 없는 자기완결 컴포넌트. Task 7이 `graph-stage` 우상단에 배치.

- [ ] **Step 1: i18n 키 추가** — `ko.ts`의 `graph:` 블록에 (en.ts에는 영문 대응):

```ts
    panel: "그래프 설정",
    reset: "기본값으로",
    filters: "필터",
    filterQuery: "검색 필터…",
    showTags: "태그 표시",
    showOrphans: "고립 노트 표시",
    localGraph: "로컬 그래프",
    localOff: "끔",
    localDepth1: "1단계",
    localDepth2: "2단계",
    groups: "그룹",
    addGroup: "그룹 추가",
    removeGroup: "그룹 삭제",
    groupQueryPlaceholder: "tag:x · path:폴더/ · 이름",
    display: "표시",
    nodeScale: "노드 크기",
    linkThickness: "링크 두께",
    forces: "힘",
    repulsion: "반발력",
    linkDistance: "링크 거리",
    gravity: "중력",
```

- [ ] **Step 2: 컴포넌트 구현** — `GraphPanel.tsx`:

```tsx
import { useState } from "react";
import { useT } from "../../i18n";
import { GRAPH_VIEW_DEFAULTS, useGraphView } from "../../stores/graphView";
import { PlusIcon, RefreshIcon, CloseIcon } from "../../shared/Icons";

// 옵시디언 그래프 설정 패널 벤치마킹: Filters/Groups/Display/Forces 접이식 섹션.
// 상태는 전부 useGraphView 스토어 — 이 컴포넌트는 얇은 바인딩만 한다.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="graph-panel-section">
      <button className="graph-panel-section-head" onClick={() => setOpen((o) => !o)}>
        <span className={open ? "graph-panel-chevron open" : "graph-panel-chevron"}>›</span>
        {title}
      </button>
      {open && <div className="graph-panel-section-body">{children}</div>}
    </div>
  );
}

function Slider({
  label, value, min, max, onChange,
}: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="graph-panel-slider">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={0.05} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function GraphPanel() {
  const t = useT();
  const { settings, update, reset } = useGraphView();
  const { filters, groups, display, forces } = settings;

  return (
    <div className="graph-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="graph-panel-head">
        <span>{t("graph.panel")}</span>
        <button onClick={reset} title={t("graph.reset")} aria-label={t("graph.reset")}>
          <RefreshIcon size={13} />
        </button>
      </div>

      <Section title={t("graph.filters")}>
        <input
          type="text" value={filters.query} placeholder={t("graph.filterQuery")} spellCheck={false}
          onChange={(e) => update({ filters: { query: e.target.value } })}
        />
        <label className="graph-panel-check">
          <input
            type="checkbox" checked={filters.showTags}
            onChange={(e) => update({ filters: { showTags: e.target.checked } })}
          />
          {t("graph.showTags")}
        </label>
        <label className="graph-panel-check">
          <input
            type="checkbox" checked={filters.showOrphans}
            onChange={(e) => update({ filters: { showOrphans: e.target.checked } })}
          />
          {t("graph.showOrphans")}
        </label>
        <label className="graph-panel-select">
          <span>{t("graph.localGraph")}</span>
          <select
            value={filters.localDepth}
            onChange={(e) => update({ filters: { localDepth: Number(e.target.value) as 0 | 1 | 2 } })}
          >
            <option value={0}>{t("graph.localOff")}</option>
            <option value={1}>{t("graph.localDepth1")}</option>
            <option value={2}>{t("graph.localDepth2")}</option>
          </select>
        </label>
      </Section>

      <Section title={t("graph.groups")}>
        {groups.map((g) => (
          <div key={g.id} className="graph-panel-group">
            <input
              type="color" value={g.color} aria-label={g.query || g.id}
              onChange={(e) =>
                update({ groups: groups.map((x) => (x.id === g.id ? { ...x, color: e.target.value } : x)) })
              }
            />
            <input
              type="text" value={g.query} placeholder={t("graph.groupQueryPlaceholder")} spellCheck={false}
              onChange={(e) =>
                update({ groups: groups.map((x) => (x.id === g.id ? { ...x, query: e.target.value } : x)) })
              }
            />
            <button
              onClick={() => update({ groups: groups.filter((x) => x.id !== g.id) })}
              title={t("graph.removeGroup")} aria-label={t("graph.removeGroup")}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
        <button
          className="graph-panel-add"
          onClick={() =>
            update({
              groups: [
                ...groups,
                // Date.now 대신 증분 식별자 — 결정적이고 충돌만 피하면 된다
                { id: `g${groups.length + 1}-${groups.map((g) => g.id).join("").length}`,
                  query: "", color: "#7c5cff" },
              ],
            })
          }
        >
          <PlusIcon size={12} /> {t("graph.addGroup")}
        </button>
      </Section>

      <Section title={t("graph.display")}>
        <Slider label={t("graph.nodeScale")} value={display.nodeScale} min={0.5} max={2}
          onChange={(v) => update({ display: { nodeScale: v } })} />
        <Slider label={t("graph.linkThickness")} value={display.linkThickness} min={0.5} max={3}
          onChange={(v) => update({ display: { linkThickness: v } })} />
      </Section>

      <Section title={t("graph.forces")}>
        <Slider label={t("graph.repulsion")} value={forces.repulsion} min={0.25} max={4}
          onChange={(v) => update({ forces: { repulsion: v } })} />
        <Slider label={t("graph.linkDistance")} value={forces.linkDistance} min={0.25} max={4}
          onChange={(v) => update({ forces: { linkDistance: v } })} />
        <Slider label={t("graph.gravity")} value={forces.gravity} min={0.25} max={4}
          onChange={(v) => update({ forces: { gravity: v } })} />
      </Section>
    </div>
  );
}
```

(주의: 그룹 id 생성에 `Date.now()`·`Math.random()`을 쓰지 않는다 — 결정성 원칙. `defaultValue` 대신 controlled input.)

- [ ] **Step 3: CSS 추가** — `styles.css`의 기존 `graph-*` 블록 뒤에:

```css
/* 그래프 설정 패널 (옵시디언 벤치마킹) — graph-stage 우상단 부유 카드 */
.graph-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 220px;
  max-height: calc(100% - 20px);
  overflow-y: auto;
  background: var(--panel-bg, rgba(30, 30, 34, 0.92));
  border: 1px solid var(--border-color, #3a3a40);
  border-radius: 8px;
  font-size: 12px;
  z-index: 2;
}
.graph-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-weight: 600;
}
.graph-panel-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: 0;
  border-top: 1px solid var(--border-color, #3a3a40);
  color: inherit;
  cursor: pointer;
}
.graph-panel-chevron { transition: transform 0.15s; }
.graph-panel-chevron.open { transform: rotate(90deg); }
.graph-panel-section-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 10px 10px;
}
.graph-panel-check, .graph-panel-select, .graph-panel-slider {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
}
.graph-panel-slider input[type="range"] { width: 110px; }
.graph-panel-group { display: flex; gap: 4px; align-items: center; }
.graph-panel-group input[type="color"] { width: 24px; height: 20px; padding: 0; border: 0; }
.graph-panel-group input[type="text"] { flex: 1; min-width: 0; }
.graph-panel-add { align-self: flex-start; }
```

(라이트 테마 변수는 기존 `graph-modal`이 쓰는 테마 변수 체계를 따른다 — styles.css에서 `graph-` 클래스들이 참조하는 변수명을 확인해 동일하게 사용.)

- [ ] **Step 4: Ladle 스토리** — `GraphPanel.stories.tsx`:

```tsx
import { GraphPanel } from "./GraphPanel";

export const Default = () => (
  <div style={{ position: "relative", width: 480, height: 420, background: "#1e1e22" }}>
    <GraphPanel />
  </div>
);
Default.storyName = "그래프 설정 패널";
```

- [ ] **Step 5: 검증 (typecheck + Ladle 수동 확인)**

Run: `npm run typecheck && npm test`
Expected: PASS (스토어 테스트가 패널의 상태 로직을 커버 — 컴포넌트는 얇은 바인딩).
Ladle: `npm run ladle` → "그래프 설정 패널" 스토리에서 섹션 접기/펼치기·슬라이더·그룹 추가/삭제, 라이트/다크 확인.

- [ ] **Step 6: 커밋**

```bash
git add src/features/graph/GraphPanel.tsx src/features/graph/GraphPanel.stories.tsx \
  src/app/styles.css src/i18n/locales/ko.ts src/i18n/locales/en.ts
git commit -m "feat(graph): 설정 패널 UI — Filters/Groups/Display/Forces 접이식 섹션"
```

---

### Task 7: GraphView 통합 — 필터·그룹 색·태그 스타일·forces 적용

**Files:**
- Modify: `src/features/graph/GraphView.tsx` (필터 파이프라인·그룹 색·태그 노드 스타일·forces 전달·패널 장착), `src/app/styles.css` (태그 노드 스타일)
- Test: `src/features/graph/GraphView.pipeline.test.ts` (신설 — JSX 없이 파이프라인 로직만)

**Interfaces:**
- Consumes: `filterGraph`/`buildTagIndex`/`groupColorOf`(Task 4), `LayoutOptions` 배율(Task 5), `useGraphView`(Task 3), `GraphPanel`(Task 6), `getCachedLayout/setCachedLayout/graphSignature`(기존)

- [ ] **Step 1: 파이프라인 헬퍼 추출 + 실패하는 테스트** — GraphView가 쓸 조합 로직을 `filter.ts`에 추가:

```ts
/** GraphView 파이프라인: 설정 → 표시용 서브그래프 (activePath는 로컬 그래프 중심) */
export function visibleGraph(
  graph: LinkGraph,
  s: GraphViewSettings,
  activePath: string | null,
): LinkGraph {
  const local =
    s.filters.localDepth > 0 && activePath && graph.nodes.some((n) => n.path === activePath)
      ? { center: activePath, depth: s.filters.localDepth as 1 | 2 }
      : undefined;
  return filterGraph(graph, {
    query: s.filters.query,
    showTags: s.filters.showTags,
    showOrphans: s.filters.showOrphans,
    local,
  });
}
```

`filter.test.ts`에 테스트 추가:

```ts
import { GRAPH_VIEW_DEFAULTS } from "../../stores/graphView";
import { visibleGraph } from "./filter";

describe("visibleGraph", () => {
  it("localDepth>0이라도 activePath가 그래프에 없으면 전체 그래프", () => {
    const s = {
      ...GRAPH_VIEW_DEFAULTS,
      filters: { ...GRAPH_VIEW_DEFAULTS.filters, localDepth: 1 as const, showOrphans: true },
    };
    expect(visibleGraph(g, s, "/없는/노트.md").nodes.length).toBe(g.nodes.length);
    expect(visibleGraph(g, s, null).nodes.length).toBe(g.nodes.length);
  });

  it("activePath가 있으면 로컬 그래프로 좁힌다", () => {
    const s = {
      ...GRAPH_VIEW_DEFAULTS,
      filters: { ...GRAPH_VIEW_DEFAULTS.filters, localDepth: 1 as const, showOrphans: true },
    };
    expect(visibleGraph(g, s, "/w/a.md").nodes.map((n) => n.path).sort())
      .toEqual(["#ai", "/w/a.md", "/w/b.md"]);
  });
});
```

Run: `npx vitest run src/features/graph/filter.test.ts` → FAIL(visibleGraph 없음) → 구현 → PASS.

- [ ] **Step 2: GraphView 배선** — `GraphView.tsx` 수정 요점 (기존 구조 유지, diff 단위):

```tsx
// import 추가
import { GraphPanel } from "./GraphPanel";
import { buildTagIndex, groupColorOf, visibleGraph } from "./filter";
import { useGraphView } from "../../stores/graphView";

// 컴포넌트 안
const gv = useGraphView((s) => s.settings);

// 원본 그래프 → 표시용 서브그래프 (필터·로컬 그래프)
const shown = useMemo(
  () => (graph ? visibleGraph(graph, gv, activePath) : null),
  [graph, gv, activePath],
);

// 레이아웃: 표시용 그래프 + forces 배율. 캐시 키에 forces를 포함해
// 슬라이더 변경 시 재계산되고, 같은 값으로 되돌리면 캐시가 살아난다.
const layout = useMemo(() => {
  if (!shown) return null;
  const f = gv.forces;
  const sig = `${graphSignature(shown)}|f:${f.repulsion},${f.linkDistance},${f.gravity}`;
  const cached = getCachedLayout(sig);
  if (cached) return cached;
  const computed = layoutGraph(shown, {
    width: WIDTH,
    height: HEIGHT,
    repulsionScale: f.repulsion,
    linkDistanceScale: f.linkDistance,
    gravityScale: f.gravity,
  });
  setCachedLayout(sig, computed);
  return computed;
}, [shown, gv.forces]);

// 그룹 색: kind별 노드 룩업 + 태그 인덱스는 표시용 그래프 기준
const nodeByPath = useMemo(() => {
  const m = new Map<string, GraphNode>();
  shown?.nodes.forEach((n) => m.set(n.path, n));
  return m;
}, [shown]);
const tagIndex = useMemo(() => (shown ? buildTagIndex(shown) : new Map()), [shown]);
const colorOf = (path: string): string | null => {
  const n = nodeByPath.get(path);
  return n ? groupColorOf(n, gv.groups, tagIndex) : null;
};
```

렌더 수정:
- `adjacencyOf(graph, hover)` → `adjacencyOf(shown, hover)` (표시용 기준), `matches`·`posByPath`·통계도 `layout`(=표시용) 기준이라 변경 불필요.
- 노드 `<circle>`: `radiusOf(...) * gv.display.nodeScale`, 그룹 색이 있으면 `style={{ fill: color, stroke: color }}` (없으면 기존 CSS 클래스 색). 태그 노드는 클래스 `graph-node-tag` 추가 + 클릭 시 노트 열기 대신 검색 필터에 태그 주입: `onClick={() => update({ filters: { query: n.name } })}` (노트 열기는 kind==="note"만).
- `degree === 0` 노드 렌더 스킵 조건(`if (!linked && !isCurrent) return null;`) **삭제** — 고립 표시는 filterGraph의 showOrphans가 담당한다.
- 엣지 `<line>`: `style={{ strokeWidth: gv.display.linkThickness }}` (vectorEffect가 있어 화면 px 단위).
- 헤더 검색(`query`)은 기존 "강조" 동작 유지 — 패널의 filterQuery(표시 자체를 거름)와 역할이 다르다.
- `graph-stage` 안에 `<GraphPanel />` 추가 (zoom 버튼과 겹치지 않게 우상단).
- 라벨: 태그 노드는 `priority`에 +50 가산(허브라 이름이 보여야 한다) — `shownLabels` cands 생성부에서 `(n.kind === "tag" ? 50 : 0)` 추가. 이를 위해 `PositionedNode`에 `kind` 전파: `layout.ts`의 `PositionedNode`에 `kind: NodeKind` 추가, `layoutGraph`의 nodes 매핑에서 `kind: node.kind` 복사 (Task 5에서 함께 해도 무방하나 여기서 수행).

- [ ] **Step 3: 태그 노드 CSS** — `styles.css`:

```css
/* 태그 허브 노드 — 노트와 시각적으로 구분 (옵시디언처럼 별색·약한 채움) */
.graph-node-tag .graph-node-dot {
  fill: var(--graph-tag-fill, #8b7ec8);
  stroke: var(--graph-tag-stroke, #a99ce0);
}
.graph-node-label-tag { font-style: italic; opacity: 0.9; }
```

- [ ] **Step 4: 로컬 게이트 전체 실행**

Run: `npm run typecheck && npm test && npm run build`
Run: `cd crates/synapse-core && cargo test && cd ../../src-tauri && cargo check`
Expected: 전부 PASS.

- [ ] **Step 5: 수동 검증 (vite dev + mock)**

Run: `npm run dev` → 브라우저에서 그래프 뷰 열기. 확인 목록 (PR 본문에 기록):
1. 태그 노드가 별색으로 표시되고 클릭하면 검색 필터로 들어간다
2. 패널 Filters: 태그/고립 토글, 검색 필터, 로컬 그래프 1·2단계
3. Groups: `tag:x` 그룹 추가 → 해당 노트들 색 변경, 그룹 삭제 시 원복
4. Display: 노드 크기·링크 두께 즉시 반영
5. Forces: 슬라이더 조정 → 레이아웃 재계산, 원값 복귀 시 캐시로 즉시 복원
6. 설정이 그래프 뷰를 닫았다 열어도, 앱 재시작(localStorage) 후에도 유지

- [ ] **Step 6: 커밋**

```bash
git add src/features/graph/ src/app/styles.css
git commit -m "feat(graph): 필터·그룹 색·태그 노드·forces 슬라이더를 그래프 뷰에 통합"
```

---

## 구현 후 실측 (2026-07-15, 10만 노트 스트레스 테스트)

합성 볼트(`?mockNotes=N`, 허브-클러스터 구조)로 실측한 결과. 재현:
`STRESS=1 npx vitest run src/features/graph/layout.stress.test.ts --silent=false`
(엔진 단독) / vite dev + `?mockNotes=100000` (브라우저 실구동).

| 규모(노트/연결 노드) | 그래프 열림 | 호버 강조 | 줌 1프레임 |
|---|---|---|---|
| 1만 / 8.3k | 1.3초 | 48ms | 11ms |
| 3만 / 24.5k | 5.9초 | 1.8초 | (미계측) |
| 10만 / 81k | 29초 | 5.1초 | 3.1초 |

- 스캔(computeGraph)·필터(filterGraph)는 10만에서도 밀리초 수준 (225ms / 14ms).
- 병목 1: force 레이아웃 (10만에서 22.5초, 동기 실행이라 UI 프리즈).
- 병목 2: SVG+React 리렌더 — 26만 SVG 요소에서 호버·줌이 초 단위.
- **실용 한계선: 연결 노드 ~1만.** 그 이상은 아래 로드맵의 canvas 전환+
  레이아웃 웹워커/증분화가 필요하다 (수치로 확정됨).
- 이 실측에서 나온 개선이 라벨 최소 반지름(`LABEL_MIN_RADIUS`): 화면상
  6px 미만 점의 이름은 생략 — 1만 노트 기준 라벨 177→14개(허브·태그만 남음),
  확대 시 다시 나타난다.

## 로드맵 (이 계획 범위 밖, 비전 연계)

- **auto-links 시각 구분**: `feat/auto-links` 머지 후 GraphEdge에 `kind: "manual" | "auto"`를 추가해 agent가 만든 링크를 점선으로 표시 — "AI가 가꾼 연결"의 가시화.
- **agent 그룹 제안**: agent가 볼트를 분석해 그룹 규칙(query+color)을 제안하는 MCP 도구.
- **상주 로컬 그래프 패널**: 모달이 아닌 사이드 패널로 현재 노트의 로컬 그래프 상시 표시 (옵시디언 local graph 대응).
- **렌더러 스케일업**: 실측으로 확정 — 연결 노드 ~1만까지는 현 SVG로 충분, 그 이상은 canvas/WebGL 렌더러 + 레이아웃 웹워커(비동기·진행 표시) + 증분 레이아웃이 필요하다 (위 실측 표 참고).

## Self-Review 결과

- 스펙 커버리지: 벤치마킹 표의 6개 신규 항목이 Task 1–7에 모두 매핑됨. 이미지의 "호버 하이라이트"·"라벨 밀도"는 기존 구현 유지로 처리.
- 타입 일관성: `NodeKind`(Rust `"note"|"tag"` serde lowercase) ↔ TS `NodeKind` 일치. `GraphViewSettings`·`FilterOptions`·`LayoutOptions` 필드명이 Task 3→4→5→7에서 동일하게 사용됨. `PositionedNode.kind` 전파는 Task 7 Step 2에 명시.
- 알려진 리스크: 기존 layout/layoutCache 테스트 픽스처에 `kind` 필드 추가 필요(Task 5 Step 1에 명시). mock의 computeGraph 경로 형태는 실행 시 실제 코드에 맞춰 조정.
