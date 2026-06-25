# Graph View 재설계 + MCP 그래프 검색 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코어에 그래프 쿼리 API를 신설해 MCP가 링크 그래프로 노트를 찾게 하고, Graph View를 Canvas 기반 실시간 시뮬레이션으로 고도화한다.

**Architecture:** (B) `crates/synapse-core/src/graph_query.rs`에 `build_graph`를 재사용하는 순수 쿼리 함수 4종을 만들고, `crates/synapse-mcp/src/main.rs`에 MCP tool 4종으로 노출한다. (A) `src/features/graph/`의 force 로직을 순수 tick 기반으로 재구성하고(`layout.ts`/`camera.ts`/`hitTest.ts`), Canvas 렌더러(`renderer.ts`)와 RAF 루프·인터랙션을 담은 `GraphView.tsx`로 교체한다.

**Tech Stack:** Rust(synapse-core, synapse-mcp, cargo test) / TypeScript + React + zustand + Canvas 2D(vitest, ladle, playwright)

## Global Constraints

- main에 직접 푸시 금지. 기능 브랜치 → PR → CI. (현재 worktree 브랜치 `worktree-graph-redesign`)
- 새 기능·버그 수정에는 테스트를 함께 추가한다. TS는 같은 폴더 `*.test.ts`(vitest), Rust는 `synapse-core`에 단위 테스트.
- 푸시 전 로컬 검증: `npm run typecheck && npm test && npm run build`, Rust 변경 시 `cargo test`(synapse-core 폴더) / `cargo check`(src-tauri 폴더).
- 코어는 GUI 비의존 순수 로직. `src-tauri`/`synapse-mcp`에는 얇은 바인딩만.
- 그래프 빌드는 on-demand(`build_graph` 1회 후 쿼리). 캐시/인덱스 도입 안 함.
- 엣지 = 위키링크 + 마크다운 링크만. 방향성 보존(`GraphEdge { source, target }`).
- ssh:// 워크스페이스 root는 그래프 tool에서 거부(기존 `search_notes`/`read_note`와 동일 규약).
- MCP tool 오류는 JSON-RPC 오류가 아니라 `result.isError=true`(텍스트 content)로 반환.

## 기존 코드 인터페이스 (참고 — 이미 존재)

```rust
// crates/synapse-core/src/links.rs
pub struct GraphNode { pub path: String, pub name: String }
pub struct GraphEdge { pub source: String, pub target: String } // 방향성: source→target
pub struct LinkGraph { pub nodes: Vec<GraphNode>, pub edges: Vec<GraphEdge> }
pub fn build_graph(root: &Path) -> io::Result<LinkGraph>;       // 경로 기준 정렬, 결정적
pub fn backlinks_for(root: &Path, target: &Path) -> io::Result<Vec<Backlink>>;
// crates/synapse-core/src/retrieval.rs
pub fn extract_keywords(question: &str, opts: &RetrievalOptions) -> Vec<String>;
// crates/synapse-core/src/lib.rs 는 search_workspace, Backend, LiveState 등을 re-export
```

```rust
// crates/synapse-mcp/src/main.rs 패턴
fn tool_defs() -> Value           // tools/list 응답 배열
fn handle_tool_call(id, msg, ctx) // name => Result<String,String>; ctx.fetch_live() → LiveState
// LiveState { root: Option<String>, active_path, active_content, open_tabs }
// 기존 search_notes 핸들러: live.root 추출 → ssh:// 거부 → search_workspace(Path, query, opts)
```

```ts
// src/features/graph/layout.ts (현재)
export function layoutGraph(graph: LinkGraph, opts?: LayoutOptions): GraphLayout; // 300회 반복 정적
export interface PositionedNode { path; name; x; y; degree }
export function adjacencyOf(graph: LinkGraph, path: string): Set<string>;
export function placeLabels(cands: LabelCandidate[]): Set<string>;
export function estimateLabelWidth(text: string, fontSize?: number): number;
// src/ipc/ipc.ts : ipc.linkGraph(root: string): Promise<LinkGraph>
```

---

# Part B — 코어 그래프 쿼리 + MCP tool (먼저, UI와 독립)

### Task 1: 코어 `graph_query` — 인접 리스트 + neighbors()

**Files:**
- Create: `crates/synapse-core/src/graph_query.rs`
- Modify: `crates/synapse-core/src/lib.rs` (모듈 등록 + re-export)
- Test: `crates/synapse-core/src/graph_query.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `links::{build_graph, LinkGraph, GraphNode, GraphEdge}`
- Produces:
  ```rust
  pub enum Direction { Out, In, Both }
  pub struct NeighborNote { pub path: String, pub name: String, pub distance: usize }
  pub fn neighbors(root: &Path, target: &Path, dir: Direction, depth: usize)
      -> io::Result<Vec<NeighborNote>>;
  // 내부 헬퍼 (다음 task들이 재사용):
  pub(crate) struct Adjacency { /* path→index, out: Vec<Vec<usize>>, in_: Vec<Vec<usize>>, nodes */ }
  pub(crate) fn adjacency(graph: &LinkGraph) -> Adjacency;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `graph_query.rs` 하단에 추가

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // 임시 워크스페이스: a→b, b→c (마크다운 링크)
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::write(root.join("a.md"), "[b](b.md)").unwrap();
        fs::write(root.join("b.md"), "[c](c.md)").unwrap();
        fs::write(root.join("c.md"), "leaf").unwrap();
        (dir, root)
    }

    #[test]
    fn neighbors_out_depth1_returns_direct_targets() {
        let (_d, root) = fixture();
        let got = neighbors(&root, &root.join("a.md"), Direction::Out, 1).unwrap();
        assert_eq!(got.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["b.md"]);
        assert_eq!(got[0].distance, 1);
    }

    #[test]
    fn neighbors_in_finds_backlinks() {
        let (_d, root) = fixture();
        let got = neighbors(&root, &root.join("b.md"), Direction::In, 1).unwrap();
        assert_eq!(got.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["a.md"]);
    }

    #[test]
    fn neighbors_both_depth2_includes_two_hops() {
        let (_d, root) = fixture();
        let got = neighbors(&root, &root.join("a.md"), Direction::Both, 2).unwrap();
        let names: Vec<_> = got.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"b.md")); // 1홉
        assert!(names.contains(&"c.md")); // 2홉
        assert!(!names.contains(&"a.md")); // 자기 자신 제외
    }
}
```

- [ ] **Step 2: 테스트 실패 확인** — `crates/synapse-core`에서 `cargo test graph_query` → 컴파일 실패(모듈/함수 없음)

- [ ] **Step 3: 구현 작성** — `graph_query.rs` 상단

```rust
//! 링크 그래프 위에서의 쿼리(이웃/검색/경로/구조). build_graph를 재사용하는 순수 로직.
use std::collections::VecDeque;
use std::io;
use std::path::Path;

use serde::Serialize;

use crate::links::{build_graph, LinkGraph};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction { Out, In, Both }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborNote { pub path: String, pub name: String, pub distance: usize }

/// 인접 리스트(인덱스 기반). path↔index 매핑과 out/in 방향 이웃을 들고 있다.
pub(crate) struct Adjacency {
    pub paths: Vec<String>,
    pub names: Vec<String>,
    pub out: Vec<Vec<usize>>,
    pub in_: Vec<Vec<usize>>,
}

impl Adjacency {
    pub fn index_of(&self, path: &str) -> Option<usize> {
        self.paths.iter().position(|p| p == path)
    }
}

pub(crate) fn adjacency(graph: &LinkGraph) -> Adjacency {
    let paths: Vec<String> = graph.nodes.iter().map(|n| n.path.clone()).collect();
    let names: Vec<String> = graph.nodes.iter().map(|n| n.name.clone()).collect();
    let idx = |p: &str| paths.iter().position(|x| x == p);
    let mut out = vec![Vec::new(); paths.len()];
    let mut in_ = vec![Vec::new(); paths.len()];
    for e in &graph.edges {
        if let (Some(s), Some(t)) = (idx(&e.source), idx(&e.target)) {
            out[s].push(t);
            in_[t].push(s);
        }
    }
    Adjacency { paths, names, out, in_ }
}

/// BFS로 target에서 depth 홉 이내 이웃을 거리와 함께 모은다. 자기 자신 제외.
pub fn neighbors(root: &Path, target: &Path, dir: Direction, depth: usize)
    -> io::Result<Vec<NeighborNote>> {
    let graph = build_graph(root)?;
    let adj = adjacency(&graph);
    let start_path = target.canonicalize().unwrap_or_else(|_| target.to_path_buf())
        .display().to_string();
    let Some(start) = adj.index_of(&start_path) else { return Ok(Vec::new()); };

    let mut dist = vec![usize::MAX; adj.paths.len()];
    let mut q = VecDeque::new();
    dist[start] = 0;
    q.push_back(start);
    let mut out = Vec::new();
    while let Some(u) = q.pop_front() {
        if dist[u] >= depth { continue; }
        let mut nexts: Vec<usize> = Vec::new();
        if matches!(dir, Direction::Out | Direction::Both) { nexts.extend(&adj.out[u]); }
        if matches!(dir, Direction::In | Direction::Both) { nexts.extend(&adj.in_[u]); }
        for v in nexts {
            if dist[v] == usize::MAX {
                dist[v] = dist[u] + 1;
                out.push(NeighborNote {
                    path: adj.paths[v].clone(),
                    name: adj.names[v].clone(),
                    distance: dist[v],
                });
                q.push_back(v);
            }
        }
    }
    out.sort_by(|a, b| a.distance.cmp(&b.distance).then(a.path.cmp(&b.path)));
    Ok(out)
}
```

`lib.rs`에 모듈 등록:
```rust
pub mod graph_query;
pub use graph_query::{neighbors, Direction, NeighborNote};
```
`Cargo.toml`의 `[dev-dependencies]`에 `tempfile`이 없으면 추가(이미 다른 테스트에서 쓰는지 먼저 `grep tempfile crates/synapse-core/Cargo.toml`로 확인).

- [ ] **Step 4: 테스트 통과 확인** — `cargo test graph_query` → 3개 PASS

- [ ] **Step 5: 커밋**

```bash
git add crates/synapse-core/src/graph_query.rs crates/synapse-core/src/lib.rs crates/synapse-core/Cargo.toml
git commit -m "feat(core): graph_query neighbors() — 이웃/백링크 BFS"
```

---

### Task 2: 코어 `graph_query` — graph_search()

**Files:**
- Modify: `crates/synapse-core/src/graph_query.rs`
- Modify: `crates/synapse-core/src/lib.rs` (re-export 추가)

**Interfaces:**
- Consumes: `adjacency`, `Adjacency`, `links::build_graph`, `retrieval::extract_keywords`, `retrieval::RetrievalOptions`, `search_workspace`, `SearchOptions`
- Produces:
  ```rust
  pub struct RelatedNote {
      pub path: String, pub name: String, pub score: u32,
      pub reason: String,   // "keyword" | "neighbor"
      pub snippet: String,
  }
  pub fn graph_search(root: &Path, query: &str, hops: usize) -> io::Result<Vec<RelatedNote>>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests` 모듈에 추가

```rust
#[test]
fn graph_search_expands_keyword_hits_along_links() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    // hub.md 가 키워드 매칭, related.md 는 hub 를 링크(이웃으로 보강)
    fs::write(root.join("hub.md"), "rust 그래프 알고리즘").unwrap();
    fs::write(root.join("related.md"), "see [[hub]] for details").unwrap();
    fs::write(root.join("noise.md"), "전혀 무관").unwrap();
    let got = graph_search(&root, "그래프", 1).unwrap();
    let names: Vec<_> = got.iter().map(|n| n.name.as_str()).collect();
    assert!(names.contains(&"hub.md"));      // 키워드 직접 매칭
    assert!(names.contains(&"related.md"));  // 링크 이웃 보강
    assert!(!names.contains(&"noise.md"));
    // 직접 매칭이 이웃보다 점수가 높다
    let hub = got.iter().find(|n| n.name == "hub.md").unwrap();
    let rel = got.iter().find(|n| n.name == "related.md").unwrap();
    assert!(hub.score > rel.score);
    assert_eq!(hub.reason, "keyword");
    assert_eq!(rel.reason, "neighbor");
}

#[test]
fn graph_search_empty_query_returns_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(graph_search(dir.path(), "  ", 1).unwrap().is_empty());
}
```

- [ ] **Step 2: 테스트 실패 확인** — `cargo test graph_search` → 컴파일 실패

- [ ] **Step 3: 구현 작성** — `graph_query.rs`에 추가

```rust
use crate::retrieval::{extract_keywords, RetrievalOptions};
use crate::search::{search_workspace, SearchOptions};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedNote {
    pub path: String,
    pub name: String,
    pub score: u32,
    pub reason: String,
    pub snippet: String,
}

/// 키워드 검색으로 시드 노트를 찾고, hops 만큼 링크(양방향)를 따라 이웃을 보강한다.
/// 점수: 직접 매칭 노트 = 매칭 키워드 수 * 10, 이웃 = (시드 점수 / 2^거리)로 감쇠.
pub fn graph_search(root: &Path, query: &str, hops: usize) -> io::Result<Vec<RelatedNote>> {
    let opts = RetrievalOptions::default();
    let keywords = extract_keywords(query, &opts);
    if keywords.is_empty() { return Ok(Vec::new()); }

    let graph = build_graph(root)?;
    let adj = adjacency(&graph);

    // 1) 시드: 키워드별 검색 → 노트별 매칭 키워드 수 누적 + 대표 스니펫
    use std::collections::HashMap;
    let mut seed_score: HashMap<usize, u32> = HashMap::new();
    let mut snippet: HashMap<usize, String> = HashMap::new();
    let sopts = SearchOptions { max_matches_per_file: 1, ..SearchOptions::default() };
    for kw in &keywords {
        for hit in search_workspace(root, kw, &sopts) {
            if let Some(i) = adj.index_of(&hit.path) {
                *seed_score.entry(i).or_insert(0) += 10;
                snippet.entry(i).or_insert_with(|| {
                    hit.matches.first().map(|m| m.snippet.clone()).unwrap_or_default()
                });
            }
        }
    }
    if seed_score.is_empty() { return Ok(Vec::new()); }

    // 2) 이웃 보강: 각 시드에서 hops 만큼 BFS, 미방문 노트에 감쇠 점수
    let mut best: HashMap<usize, (u32, String)> = HashMap::new(); // idx → (score, reason)
    for (&seed, &sc) in &seed_score {
        best.insert(seed, (sc, "keyword".to_string()));
    }
    for (&seed, &sc) in &seed_score {
        let mut dist = vec![usize::MAX; adj.paths.len()];
        let mut q = VecDeque::new();
        dist[seed] = 0; q.push_back(seed);
        while let Some(u) = q.pop_front() {
            if dist[u] >= hops { continue; }
            for &v in adj.out[u].iter().chain(adj.in_[u].iter()) {
                if dist[v] == usize::MAX {
                    dist[v] = dist[u] + 1;
                    let decayed = sc >> dist[v]; // /2^거리
                    let entry = best.entry(v).or_insert((0, "neighbor".to_string()));
                    if decayed > entry.0 && !seed_score.contains_key(&v) {
                        *entry = (decayed, "neighbor".to_string());
                    }
                    q.push_back(v);
                }
            }
        }
    }

    let mut out: Vec<RelatedNote> = best.into_iter().map(|(i, (score, reason))| RelatedNote {
        path: adj.paths[i].clone(),
        name: adj.names[i].clone(),
        score,
        reason,
        snippet: snippet.get(&i).cloned().unwrap_or_default(),
    }).collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.path.cmp(&b.path)));
    Ok(out)
}
```

`lib.rs`: `pub use graph_query::{graph_search, RelatedNote};` 추가. `search`/`retrieval` 모듈 가시성 확인(이미 `pub(crate)` 이상이어야 함 — 아니면 `use crate::search::...`가 동작하도록 모듈 경로 확인).

- [ ] **Step 4: 테스트 통과 확인** — `cargo test graph_search` → 2개 PASS

- [ ] **Step 5: 커밋**

```bash
git add crates/synapse-core/src/graph_query.rs crates/synapse-core/src/lib.rs
git commit -m "feat(core): graph_search() — 키워드 검색 + 링크 이웃 보강"
```

---

### Task 3: 코어 `graph_query` — path_between()

**Files:**
- Modify: `crates/synapse-core/src/graph_query.rs`, `crates/synapse-core/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct PathStep { pub path: String, pub name: String }
  pub fn path_between(root: &Path, from: &Path, to: &Path) -> io::Result<Option<Vec<PathStep>>>;
  // None = 경로 없음(에러 아님). Some(vec) = from..=to 순서.
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```rust
#[test]
fn path_between_finds_shortest_chain() {
    let (_d, root) = fixture(); // a→b→c
    let p = path_between(&root, &root.join("a.md"), &root.join("c.md")).unwrap().unwrap();
    assert_eq!(p.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["a.md", "b.md", "c.md"]);
}

#[test]
fn path_between_returns_none_when_disconnected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    fs::write(root.join("x.md"), "lone").unwrap();
    fs::write(root.join("y.md"), "lone").unwrap();
    assert!(path_between(&root, &root.join("x.md"), &root.join("y.md")).unwrap().is_none());
}
```

- [ ] **Step 2: 테스트 실패 확인** — `cargo test path_between`

- [ ] **Step 3: 구현 작성**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStep { pub path: String, pub name: String }

/// from→to 최단 연결 경로(엣지를 양방향으로 취급). 경로 없으면 None.
pub fn path_between(root: &Path, from: &Path, to: &Path) -> io::Result<Option<Vec<PathStep>>> {
    let graph = build_graph(root)?;
    let adj = adjacency(&graph);
    let abs = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()).display().to_string();
    let (Some(s), Some(t)) = (adj.index_of(&abs(from)), adj.index_of(&abs(to)))
        else { return Ok(None); };
    if s == t { return Ok(Some(vec![PathStep { path: adj.paths[s].clone(), name: adj.names[s].clone() }])); }

    let mut prev = vec![usize::MAX; adj.paths.len()];
    let mut seen = vec![false; adj.paths.len()];
    let mut q = VecDeque::new();
    seen[s] = true; q.push_back(s);
    while let Some(u) = q.pop_front() {
        for &v in adj.out[u].iter().chain(adj.in_[u].iter()) {
            if !seen[v] {
                seen[v] = true; prev[v] = u; q.push_back(v);
                if v == t {
                    let mut chain = vec![t];
                    let mut cur = t;
                    while cur != s { cur = prev[cur]; chain.push(cur); }
                    chain.reverse();
                    return Ok(Some(chain.into_iter().map(|i| PathStep {
                        path: adj.paths[i].clone(), name: adj.names[i].clone(),
                    }).collect()));
                }
            }
        }
    }
    Ok(None)
}
```

`lib.rs`: `pub use graph_query::{path_between, PathStep};`

- [ ] **Step 4: 테스트 통과 확인** — `cargo test path_between` → 2개 PASS

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat(core): path_between() — 두 노트 사이 최단 경로 BFS"
```

---

### Task 4: 코어 `graph_query` — graph_overview()

**Files:**
- Modify: `crates/synapse-core/src/graph_query.rs`, `crates/synapse-core/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct HubNote { pub path: String, pub name: String, pub degree: usize }
  pub struct GraphOverview {
      pub node_count: usize, pub edge_count: usize,
      pub hubs: Vec<HubNote>,        // degree 내림차순 상위 N
      pub isolated: Vec<String>,     // degree 0 노트 path
      pub component_count: usize,
  }
  pub fn graph_overview(root: &Path) -> io::Result<GraphOverview>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```rust
#[test]
fn overview_reports_hubs_isolated_and_components() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    fs::write(root.join("hub.md"), "[a](a.md) [b](b.md)").unwrap(); // degree 2 (out)
    fs::write(root.join("a.md"), "back [[hub]]").unwrap();
    fs::write(root.join("b.md"), "leaf").unwrap();
    fs::write(root.join("lone.md"), "고립").unwrap();               // degree 0
    let ov = graph_overview(&root).unwrap();
    assert_eq!(ov.node_count, 4);
    assert_eq!(ov.hubs.first().unwrap().name, "hub.md");
    assert!(ov.isolated.iter().any(|p| p.ends_with("lone.md")));
    assert_eq!(ov.component_count, 2); // {hub,a,b} 와 {lone}
}
```

- [ ] **Step 2: 테스트 실패 확인** — `cargo test overview`

- [ ] **Step 3: 구현 작성**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubNote { pub path: String, pub name: String, pub degree: usize }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphOverview {
    pub node_count: usize,
    pub edge_count: usize,
    pub hubs: Vec<HubNote>,
    pub isolated: Vec<String>,
    pub component_count: usize,
}

const OVERVIEW_TOP_HUBS: usize = 10;

pub fn graph_overview(root: &Path) -> io::Result<GraphOverview> {
    let graph = build_graph(root)?;
    let adj = adjacency(&graph);
    let n = adj.paths.len();
    let degree: Vec<usize> = (0..n).map(|i| adj.out[i].len() + adj.in_[i].len()).collect();

    let mut hubs: Vec<HubNote> = (0..n).filter(|&i| degree[i] > 0).map(|i| HubNote {
        path: adj.paths[i].clone(), name: adj.names[i].clone(), degree: degree[i],
    }).collect();
    hubs.sort_by(|a, b| b.degree.cmp(&a.degree).then(a.path.cmp(&b.path)));
    hubs.truncate(OVERVIEW_TOP_HUBS);

    let isolated: Vec<String> = (0..n).filter(|&i| degree[i] == 0)
        .map(|i| adj.paths[i].clone()).collect();

    // 연결 컴포넌트 수(무방향 union-find)
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, x: usize) -> usize {
        if p[x] != x { let r = find(p, p[x]); p[x] = r; } p[x]
    }
    for u in 0..n {
        for &v in &adj.out[u] {
            let (ru, rv) = (find(&mut parent, u), find(&mut parent, v));
            if ru != rv { parent[ru] = rv; }
        }
    }
    let component_count = (0..n).filter(|&i| find(&mut parent, i) == i).count();

    Ok(GraphOverview {
        node_count: n, edge_count: graph.edges.len(),
        hubs, isolated, component_count,
    })
}
```

`lib.rs`: `pub use graph_query::{graph_overview, GraphOverview, HubNote};`

- [ ] **Step 4: 테스트 통과 확인** — `cargo test overview` → PASS. 그 후 `cargo test`(synapse-core 전체) → 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat(core): graph_overview() — 허브/고립/컴포넌트 통계"
```

---

### Task 5: MCP tool 4종 노출 + 텍스트 포맷

**Files:**
- Modify: `crates/synapse-mcp/src/main.rs` (tool_defs + handle_tool_call + 포맷 순수 함수 + 테스트)

**Interfaces:**
- Consumes: `synapse_core::{neighbors, Direction, graph_search, path_between, graph_overview}` (코어 re-export)
- 패턴: 기존 `search_notes` 핸들러처럼 `ctx.fetch_live()` → `live.root` 추출 → ssh:// 거부 → 코어 호출 → 텍스트 포맷. 입력 `path`/`from`/`to`는 워크스페이스 기준 경로를 절대경로로 해석(기존 `read_note`의 경로 해석 헬퍼 재사용).

- [ ] **Step 1: 실패하는 테스트 작성** — `main.rs` `#[cfg(test)]`에 추가 (기존 `tool_defs_list_tools_with_object_schemas` 패턴 따름)

```rust
#[test]
fn tool_defs_includes_graph_tools() {
    let defs = tool_defs();
    let names: Vec<&str> = defs.as_array().unwrap().iter()
        .filter_map(|d| d["name"].as_str()).collect();
    for n in ["note_links", "find_related", "note_path", "graph_overview"] {
        assert!(names.contains(&n), "missing tool: {n}");
    }
    // 모든 도구는 object 타입 inputSchema 를 가진다
    for d in defs.as_array().unwrap() {
        assert_eq!(d["inputSchema"]["type"], "object");
    }
}

#[test]
fn graph_overview_format_lists_hubs() {
    use synapse_core::{GraphOverview, HubNote};
    let ov = GraphOverview {
        node_count: 3, edge_count: 2,
        hubs: vec![HubNote { path: "/ws/hub.md".into(), name: "hub.md".into(), degree: 2 }],
        isolated: vec!["/ws/lone.md".into()],
        component_count: 2,
    };
    let text = format_overview(&ov);
    assert!(text.contains("hub.md"));
    assert!(text.contains("노드 3"));
}
```

- [ ] **Step 2: 테스트 실패 확인** — `crates/synapse-mcp`에서 `cargo test` → 컴파일 실패

- [ ] **Step 3: 구현 작성**

`tool_defs()`의 배열에 4개 항목 추가(기존 `search_notes` 정의 바로 뒤):
```rust
json!({
    "name": "note_links",
    "description": "특정 노트에 연결된 노트(아웃링크/백링크/양방향)를 홉 거리와 함께 조회한다.",
    "inputSchema": { "type": "object", "properties": {
        "path": { "type": "string", "description": "워크스페이스 기준 노트 경로" },
        "direction": { "type": "string", "enum": ["out", "in", "both"], "description": "기본 both" },
        "depth": { "type": "number", "description": "탐색 홉 수, 기본 1" }
    }, "required": ["path"] }
}),
json!({
    "name": "find_related",
    "description": "키워드로 노트를 찾고 링크로 이어진 관련 노트까지 점수순으로 반환한다.",
    "inputSchema": { "type": "object", "properties": {
        "query": { "type": "string" },
        "hops": { "type": "number", "description": "링크 확장 홉 수, 기본 1" }
    }, "required": ["query"] }
}),
json!({
    "name": "note_path",
    "description": "두 노트 사이의 최단 연결 경로(노드 시퀀스)를 찾는다.",
    "inputSchema": { "type": "object", "properties": {
        "from": { "type": "string" }, "to": { "type": "string" }
    }, "required": ["from", "to"] }
}),
json!({
    "name": "graph_overview",
    "description": "워크스페이스 링크 그래프 구조 요약(허브/고립 노트/컴포넌트/통계).",
    "inputSchema": { "type": "object", "properties": {} }
}),
```

`handle_tool_call`의 `match name`에 4개 arm 추가. root 추출은 기존 `search_notes` 핸들러와 동일한 로직을 헬퍼로 묶어 재사용:
```rust
// 기존 search_notes 핸들러에서 쓰는 root 추출 로직을 함수로 추출(중복 제거):
fn local_root(live: &LiveState) -> Result<std::path::PathBuf, String> {
    let root = live.root.as_deref()
        .ok_or_else(|| "워크스페이스가 열려 있지 않습니다".to_string())?;
    if root.starts_with("ssh://") {
        return Err("원격(ssh) 워크스페이스에서는 그래프 도구를 쓸 수 없습니다".to_string());
    }
    Ok(std::path::PathBuf::from(root))
}
// 경로 인자 → 절대경로(루트 기준). read_note의 ensure_within 규약 재사용.
fn resolve_arg_path(root: &Path, p: &str) -> std::path::PathBuf {
    let pb = Path::new(p);
    if pb.is_absolute() { pb.to_path_buf() } else { root.join(pb) }
}
```
arm 구현:
```rust
"note_links" => ctx.fetch_live().and_then(|live| {
    let root = local_root(&live)?;
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    if path.is_empty() { return Err("path 인자가 필요합니다".into()); }
    let dir = match args.get("direction").and_then(Value::as_str) {
        Some("out") => Direction::Out, Some("in") => Direction::In, _ => Direction::Both,
    };
    let depth = args.get("depth").and_then(Value::as_u64).unwrap_or(1) as usize;
    let target = resolve_arg_path(&root, path);
    let ns = neighbors(&root, &target, dir, depth.max(1))
        .map_err(|e| format!("그래프 조회 실패: {e}"))?;
    Ok(format_neighbors(path, &ns))
}),
"find_related" => ctx.fetch_live().and_then(|live| {
    let root = local_root(&live)?;
    let query = args.get("query").and_then(Value::as_str).unwrap_or("");
    let hops = args.get("hops").and_then(Value::as_u64).unwrap_or(1) as usize;
    let rs = graph_search(&root, query, hops)
        .map_err(|e| format!("그래프 검색 실패: {e}"))?;
    Ok(format_related(query, &rs))
}),
"note_path" => ctx.fetch_live().and_then(|live| {
    let root = local_root(&live)?;
    let from = args.get("from").and_then(Value::as_str).unwrap_or("");
    let to = args.get("to").and_then(Value::as_str).unwrap_or("");
    if from.is_empty() || to.is_empty() { return Err("from/to 인자가 필요합니다".into()); }
    let p = path_between(&root, &resolve_arg_path(&root, from), &resolve_arg_path(&root, to))
        .map_err(|e| format!("경로 탐색 실패: {e}"))?;
    Ok(format_path(from, to, p.as_deref()))
}),
"graph_overview" => ctx.fetch_live().and_then(|live| {
    let root = local_root(&live)?;
    let ov = graph_overview(&root).map_err(|e| format!("그래프 요약 실패: {e}"))?;
    Ok(format_overview(&ov))
}),
```
포맷 순수 함수(파일 하단 "도구 로직" 영역):
```rust
fn format_neighbors(path: &str, ns: &[synapse_core::NeighborNote]) -> String {
    if ns.is_empty() { return format!("'{path}'에 연결된 노트가 없습니다."); }
    let mut s = format!("# '{path}'의 연결 노트 ({}개)\n", ns.len());
    for n in ns { s.push_str(&format!("- {} ({}홉)\n  경로: {}\n", n.name, n.distance, n.path)); }
    s
}
fn format_related(query: &str, rs: &[synapse_core::RelatedNote]) -> String {
    if rs.is_empty() { return format!("'{query}' 관련 노트를 찾지 못했습니다."); }
    let mut s = format!("# '{query}' 관련 노트 ({}개)\n", rs.len());
    for r in rs {
        s.push_str(&format!("## {} [{}] score={}\n경로: {}\n", r.name, r.reason, r.score, r.path));
        if !r.snippet.is_empty() { s.push_str(&format!("  {}\n", r.snippet)); }
    }
    s
}
fn format_path(from: &str, to: &str, p: Option<&[synapse_core::PathStep]>) -> String {
    match p {
        None => format!("'{from}'에서 '{to}'로 가는 연결 경로가 없습니다."),
        Some(steps) => {
            let chain = steps.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(" → ");
            format!("# 연결 경로 ({}단계)\n{}", steps.len(), chain)
        }
    }
}
fn format_overview(ov: &synapse_core::GraphOverview) -> String {
    let mut s = format!(
        "# 그래프 요약\n노드 {} · 엣지 {} · 컴포넌트 {}\n\n## 허브\n",
        ov.node_count, ov.edge_count, ov.component_count);
    for h in &ov.hubs { s.push_str(&format!("- {} (degree {})\n  {}\n", h.name, h.degree, h.path)); }
    s.push_str(&format!("\n## 고립 노트 ({}개)\n", ov.isolated.len()));
    for p in ov.isolated.iter().take(20) { s.push_str(&format!("- {p}\n")); }
    s
}
```
상단 `use synapse_core::{...}`에 `Direction, neighbors, graph_search, path_between, graph_overview` 추가.

- [ ] **Step 4: 테스트 통과 확인** — `crates/synapse-mcp`에서 `cargo test` → 신규 2개 + 기존 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add crates/synapse-mcp/src/main.rs
git commit -m "feat(mcp): 그래프 tool 4종(note_links/find_related/note_path/graph_overview)"
```

---

### Task 6: MCP E2E 브리지 테스트에 그래프 tool 왕복 추가

**Files:**
- Modify: `crates/synapse-mcp/tests/bridge_e2e.rs`

**Interfaces:**
- Consumes: 기존 E2E 하네스(가짜 브리지 서버 + stdio 왕복). 기존 `search_notes` 왕복 테스트를 템플릿으로 사용.

- [ ] **Step 1: 테스트 추가** — 먼저 `grep -n 'search_notes\|tools/call\|fn ' crates/synapse-mcp/tests/bridge_e2e.rs`로 기존 헬퍼/픽스처 형태를 확인한 뒤, `graph_overview`(인자 없음 → 브리지 root만 있으면 됨) 왕복을 추가한다.

```rust
#[test]
fn graph_overview_tool_roundtrips_over_bridge() {
    // 기존 search_notes E2E와 동일한 임시 워크스페이스 + 가짜 /live 브리지 셋업 재사용.
    // (셋업 헬퍼 이름은 파일 확인 후 맞춘다. 아래는 호출 형태 예시)
    let ws = setup_workspace(&[("a.md", "[b](b.md)"), ("b.md", "leaf")]);
    let bridge = start_fake_bridge(&ws);
    let resp = call_tool(&bridge, "graph_overview", json!({}));
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("그래프 요약"));
    assert!(text.contains("노드 2"));
}
```

- [ ] **Step 2: 테스트 실패/통과 확인** — `cargo test --test bridge_e2e` 실행. 헬퍼 이름이 다르면 컴파일 에러 메시지대로 픽스처 호출을 맞춘 뒤 PASS 확인.

- [ ] **Step 3: 커밋**

```bash
git add crates/synapse-mcp/tests/bridge_e2e.rs
git commit -m "test(mcp): graph_overview tool 브리지 E2E 왕복"
```

---

# Part A — Graph View Canvas 재설계 (UI)

### Task 7: `camera.ts` — 줌/팬 좌표 변환 (순수)

**Files:**
- Create: `src/features/graph/camera.ts`
- Test: `src/features/graph/camera.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Camera { k: number; tx: number; ty: number }
  export const IDENTITY: Camera;
  export function worldToScreen(cam: Camera, x: number, y: number): { x: number; y: number };
  export function screenToWorld(cam: Camera, x: number, y: number): { x: number; y: number };
  export function zoomAround(cam: Camera, sx: number, sy: number, factor: number, min: number, max: number): Camera;
  ```
  (GraphView가 기존 `View {k,tx,ty}` 대신 이 `Camera`를 사용한다.)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, it, expect } from "vitest";
import { IDENTITY, worldToScreen, screenToWorld, zoomAround } from "./camera";

describe("camera", () => {
  it("worldToScreen/screenToWorld 가 서로 역변환", () => {
    const cam = { k: 2, tx: 30, ty: -10 };
    const s = worldToScreen(cam, 100, 50);
    const w = screenToWorld(cam, s.x, s.y);
    expect(w.x).toBeCloseTo(100);
    expect(w.y).toBeCloseTo(50);
  });
  it("zoomAround 는 커서 아래 월드 좌표를 고정한다", () => {
    const before = screenToWorld(IDENTITY, 200, 150);
    const cam = zoomAround(IDENTITY, 200, 150, 1.5, 0.4, 5);
    const after = screenToWorld(cam, 200, 150);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(cam.k).toBeCloseTo(1.5);
  });
  it("zoomAround 는 min/max 로 클램프", () => {
    expect(zoomAround(IDENTITY, 0, 0, 100, 0.4, 5).k).toBe(5);
    expect(zoomAround(IDENTITY, 0, 0, 0.001, 0.4, 5).k).toBe(0.4);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인** — `npm test -- camera` → FAIL(모듈 없음)

- [ ] **Step 3: 구현 작성**

```ts
// 화면 좌표 = world * k + t.  (GraphView 의 <g transform="translate(t) scale(k)"> 와 동일한 모델)
export interface Camera { k: number; tx: number; ty: number }
export const IDENTITY: Camera = { k: 1, tx: 0, ty: 0 };

export function worldToScreen(cam: Camera, x: number, y: number) {
  return { x: x * cam.k + cam.tx, y: y * cam.k + cam.ty };
}
export function screenToWorld(cam: Camera, x: number, y: number) {
  return { x: (x - cam.tx) / cam.k, y: (y - cam.ty) / cam.k };
}
export function zoomAround(
  cam: Camera, sx: number, sy: number, factor: number, min: number, max: number,
): Camera {
  const k = Math.max(min, Math.min(max, cam.k * factor));
  const f = k / cam.k;
  return { k, tx: sx - (sx - cam.tx) * f, ty: sy - (sy - cam.ty) * f };
}
```

- [ ] **Step 4: 테스트 통과 확인** — `npm test -- camera` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/camera.ts src/features/graph/camera.test.ts
git commit -m "feat(graph): camera 좌표 변환 순수 모듈"
```

---

### Task 8: `hitTest.ts` — 좌표→노드 (순수)

**Files:**
- Create: `src/features/graph/hitTest.ts`
- Test: `src/features/graph/hitTest.test.ts`

**Interfaces:**
- Consumes: `PositionedNode`(layout.ts), `Camera`(camera.ts)
- Produces:
  ```ts
  export interface HitNode { path: string; x: number; y: number; r: number }
  // 화면 좌표(sx,sy)에서 반경 안에 든 가장 가까운 노드의 path. 없으면 null.
  export function nodeAtScreen(nodes: HitNode[], cam: Camera, sx: number, sy: number): string | null;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, it, expect } from "vitest";
import { nodeAtScreen } from "./hitTest";
import { IDENTITY } from "./camera";

const nodes = [
  { path: "a", x: 100, y: 100, r: 6 },
  { path: "b", x: 300, y: 100, r: 6 },
];

describe("hitTest", () => {
  it("노드 중심 근처를 맞춘다", () => {
    expect(nodeAtScreen(nodes, IDENTITY, 102, 101)).toBe("a");
  });
  it("빈 공간은 null", () => {
    expect(nodeAtScreen(nodes, IDENTITY, 200, 300)).toBeNull();
  });
  it("겹칠 때 더 가까운 노드", () => {
    expect(nodeAtScreen(nodes, IDENTITY, 290, 100)).toBe("b");
  });
  it("줌 상태에서도 화면 반경 기준으로 맞춘다", () => {
    const cam = { k: 2, tx: 0, ty: 0 }; // a 는 화면상 (200,200)
    expect(nodeAtScreen(nodes, cam, 204, 200)).toBe("a");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인** — `npm test -- hitTest` → FAIL

- [ ] **Step 3: 구현 작성**

```ts
import { type Camera, worldToScreen } from "./camera";

export interface HitNode { path: string; x: number; y: number; r: number }

// 화면 반경 = 노드 반경 * 줌 + 여유 패딩. 가장 가까운(중심거리 최소) 후보를 고른다.
const HIT_PAD = 4;

export function nodeAtScreen(
  nodes: HitNode[], cam: Camera, sx: number, sy: number,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const s = worldToScreen(cam, n.x, n.y);
    const dx = s.x - sx;
    const dy = s.y - sy;
    const d2 = dx * dx + dy * dy;
    const rad = n.r * cam.k + HIT_PAD;
    if (d2 <= rad * rad && d2 < bestD) { bestD = d2; best = n.path; }
  }
  return best;
}
```

- [ ] **Step 4: 테스트 통과 확인** — `npm test -- hitTest` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/hitTest.ts src/features/graph/hitTest.test.ts
git commit -m "feat(graph): hitTest 좌표→노드 순수 모듈"
```

---

### Task 9: `layout.ts` — 점진 tick 시뮬레이션 추가

**Files:**
- Modify: `src/features/graph/layout.ts`
- Test: `src/features/graph/layout.test.ts` (없으면 생성, 있으면 추가)

**Interfaces:**
- Consumes: `LinkGraph`, 기존 `layoutGraph`(초기 배치에 재사용)
- Produces:
  ```ts
  export interface SimNode { path: string; name: string; x: number; y: number; vx: number; vy: number; degree: number; fixed: boolean }
  export interface SimState { nodes: SimNode[]; edges: { source: string; target: string }[]; width: number; height: number; alpha: number }
  export function initSim(graph: LinkGraph, opts?: LayoutOptions): SimState;   // 결정적 초기 배치(기존 해시 재사용) + alpha=1
  export function tickSim(s: SimState): SimState;                              // 1스텝 전진, alpha 감쇠, 반환은 새 객체(불변)
  export function reheat(s: SimState, alpha?: number): SimState;               // alpha 재설정
  export function setFixed(s: SimState, path: string, x: number, y: number, fixed: boolean): SimState; // 드래그용
  ```
  기존 `layoutGraph`/`adjacencyOf`/`placeLabels`/`estimateLabelWidth`는 그대로 둔다(라벨·강조 재사용).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, it, expect } from "vitest";
import { initSim, tickSim, reheat } from "./layout";

const graph = {
  nodes: [{ path: "a", name: "a" }, { path: "b", name: "b" }, { path: "c", name: "c" }],
  edges: [{ source: "a", target: "b" }],
};

describe("force sim", () => {
  it("initSim 은 결정적(같은 입력 → 같은 좌표)", () => {
    const s1 = initSim(graph, { width: 400, height: 300 });
    const s2 = initSim(graph, { width: 400, height: 300 });
    expect(s1.nodes.map((n) => [n.x, n.y])).toEqual(s2.nodes.map((n) => [n.x, n.y]));
    expect(s1.alpha).toBe(1);
  });
  it("tickSim 은 alpha 를 감소시키고 경계 안에 머문다", () => {
    let s = initSim(graph, { width: 400, height: 300 });
    const a0 = s.alpha;
    for (let i = 0; i < 50; i++) s = tickSim(s);
    expect(s.alpha).toBeLessThan(a0);
    for (const n of s.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(400);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(300);
    }
  });
  it("연결된 노드(a,b)가 비연결(c)보다 가까워진다", () => {
    let s = initSim(graph, { width: 400, height: 300 });
    for (let i = 0; i < 200; i++) s = tickSim(s);
    const get = (p: string) => s.nodes.find((n) => n.path === p)!;
    const dist = (p: string, q: string) => Math.hypot(get(p).x - get(q).x, get(p).y - get(q).y);
    expect(dist("a", "b")).toBeLessThan(dist("a", "c"));
  });
  it("reheat 은 alpha 를 올린다", () => {
    let s = initSim(graph);
    for (let i = 0; i < 100; i++) s = tickSim(s);
    const low = s.alpha;
    s = reheat(s);
    expect(s.alpha).toBeGreaterThan(low);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인** — `npm test -- layout` → FAIL

- [ ] **Step 3: 구현 작성** — `layout.ts`에 추가. 기존 `layoutGraph`의 force 상수(반발 `k²`, 스프링 `0.02`/`k*0.8`, gravity `0.01`, 경계 패딩 24)와 `hash01` 초기 배치를 재사용한다. 핵심 골격:

```ts
export interface SimNode {
  path: string; name: string; x: number; y: number;
  vx: number; vy: number; degree: number; fixed: boolean;
}
export interface SimState {
  nodes: SimNode[];
  edges: { source: string; target: string }[];
  width: number; height: number; alpha: number;
}

const PAD = 24;
const DAMPING = 0.85;
const ALPHA_DECAY = 0.98;
const ALPHA_MIN = 0.02;

export function initSim(graph: LinkGraph, opts: LayoutOptions = {}): SimState {
  // 기존 layoutGraph 로 결정적 초기 좌표 + degree 를 얻고, 속도 0 으로 감싼다.
  const base = layoutGraph(graph, { ...opts, iterations: 0 }); // iterations=0 → 초기 배치만
  const nodes: SimNode[] = base.nodes.map((n) => ({
    path: n.path, name: n.name, x: n.x, y: n.y, vx: 0, vy: 0, degree: n.degree, fixed: false,
  }));
  return { nodes, edges: base.edges, width: base.width, height: base.height, alpha: 1 };
}

export function tickSim(s: SimState): SimState {
  const n = s.nodes.length;
  if (n === 0) return s;
  const k = Math.sqrt((s.width * s.height) / Math.max(1, n));
  const repulsion = k * k;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const idx = new Map(s.nodes.map((nd, i) => [nd.path, i] as const));

  // 반발 (O(n²))
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let dx = s.nodes[i].x - s.nodes[j].x;
    let dy = s.nodes[i].y - s.nodes[j].y;
    let d2 = dx * dx + dy * dy || 0.01;
    const f = (repulsion / d2) * s.alpha;
    const d = Math.sqrt(d2);
    const ux = dx / d, uy = dy / d;
    fx[i] += ux * f; fy[i] += uy * f; fx[j] -= ux * f; fy[j] -= uy * f;
  }
  // 스프링
  for (const e of s.edges) {
    const a = idx.get(e.source), b = idx.get(e.target);
    if (a == null || b == null) continue;
    const dx = s.nodes[b].x - s.nodes[a].x, dy = s.nodes[b].y - s.nodes[a].y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = 0.02 * (d - k * 0.8) * s.alpha;
    const ux = dx / d, uy = dy / d;
    fx[a] += ux * f; fy[a] += uy * f; fx[b] -= ux * f; fy[b] -= uy * f;
  }
  // 중심 끌림
  const cx = s.width / 2, cy = s.height / 2;
  const nodes = s.nodes.map((nd, i) => {
    if (nd.fixed) return nd;
    let vx = (nd.vx + fx[i] + (cx - nd.x) * 0.01 * s.alpha) * DAMPING;
    let vy = (nd.vy + fy[i] + (cy - nd.y) * 0.01 * s.alpha) * DAMPING;
    let x = Math.max(PAD, Math.min(s.width - PAD, nd.x + vx));
    let y = Math.max(PAD, Math.min(s.height - PAD, nd.y + vy));
    return { ...nd, x, y, vx, vy };
  });
  const alpha = Math.max(ALPHA_MIN, s.alpha * ALPHA_DECAY);
  return { ...s, nodes, alpha };
}

export function reheat(s: SimState, alpha = 0.6): SimState {
  return { ...s, alpha: Math.max(s.alpha, alpha) };
}
export function setFixed(s: SimState, path: string, x: number, y: number, fixed: boolean): SimState {
  return {
    ...s,
    nodes: s.nodes.map((n) => (n.path === path ? { ...n, x, y, vx: 0, vy: 0, fixed } : n)),
    alpha: Math.max(s.alpha, 0.3),
  };
}
```
주의: 기존 `layoutGraph`가 `iterations: 0`을 지원하는지 확인하고, 안 하면 0회 분기(초기 배치 후 즉시 반환)를 추가한다.

- [ ] **Step 4: 테스트 통과 확인** — `npm test -- layout` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/layout.ts src/features/graph/layout.test.ts
git commit -m "feat(graph): force 시뮬레이션 tick API (initSim/tickSim/reheat/setFixed)"
```

---

### Task 10: `renderer.ts` — Canvas scene 드로잉 (순수 ops + draw)

**Files:**
- Create: `src/features/graph/renderer.ts`
- Test: `src/features/graph/renderer.test.ts`

**Interfaces:**
- Consumes: `SimState`/`SimNode`(layout.ts), `Camera`(camera.ts)
- Produces:
  ```ts
  export interface GraphTheme { bg: string; edge: string; edgeActive: string; node: string; nodeIso: string; current: string; label: string; halo: string }
  export interface RenderInput {
    sim: SimState; cam: Camera; theme: GraphTheme;
    width: number; height: number; dpr: number;
    hover: string | null; selected: string | null; current: string | null;
    neighbors: Set<string> | null; matches: Set<string> | null; shownLabels: Set<string>;
    maxDegree: number;
  }
  export type DrawOp =
    | { op: "clear" } | { op: "edge"; active: boolean; dimmed: boolean; x1: number; y1: number; x2: number; y2: number }
    | { op: "halo"; x: number; y: number; r: number } | { op: "node"; x: number; y: number; r: number; kind: "iso" | "linked" | "current" | "active"; dimmed: boolean }
    | { op: "label"; x: number; y: number; text: string };
  export function buildScene(input: RenderInput): DrawOp[];        // 순수: 테스트 대상
  export function draw(ctx: CanvasRenderingContext2D, input: RenderInput): void; // ops 를 캔버스에 그림
  export function radiusOf(degree: number, maxDegree: number): number; // 기존 GraphView 의 식 이전
  ```

- [ ] **Step 1: 실패하는 테스트 작성** (픽셀이 아니라 scene ops 검증)

```ts
import { describe, it, expect } from "vitest";
import { buildScene, radiusOf, type RenderInput } from "./renderer";
import { initSim } from "./layout";
import { IDENTITY } from "./camera";

const theme = { bg: "#000", edge: "#555", edgeActive: "#7c6cf0", node: "#7c6cf0",
  nodeIso: "#888", current: "#fff", label: "#ddd", halo: "#7c6cf0" };

function baseInput(): RenderInput {
  const sim = initSim({ nodes: [{ path: "a", name: "a" }, { path: "b", name: "b" }],
    edges: [{ source: "a", target: "b" }] }, { width: 400, height: 300 });
  return { sim, cam: IDENTITY, theme, width: 400, height: 300, dpr: 1,
    hover: null, selected: null, current: null, neighbors: null, matches: null,
    shownLabels: new Set(["a"]), maxDegree: 1 };
}

describe("renderer scene", () => {
  it("clear 로 시작하고 엣지/노드 ops 를 포함", () => {
    const ops = buildScene(baseInput());
    expect(ops[0]).toEqual({ op: "clear" });
    expect(ops.some((o) => o.op === "edge")).toBe(true);
    expect(ops.filter((o) => o.op === "node")).toHaveLength(2);
  });
  it("shownLabels 에 든 노드만 label op", () => {
    const ops = buildScene(baseInput());
    const labels = ops.filter((o) => o.op === "label");
    expect(labels).toHaveLength(1);
    expect((labels[0] as { text: string }).text).toBe("a");
  });
  it("hover 시 인접 엣지는 active, 비인접은 dimmed", () => {
    const input = { ...baseInput(), hover: "a", neighbors: new Set(["b"]) };
    const ops = buildScene(input);
    const edge = ops.find((o) => o.op === "edge") as { active: boolean };
    expect(edge.active).toBe(true);
  });
  it("radiusOf 는 degree 0 이면 작은 고정값", () => {
    expect(radiusOf(0, 5)).toBeCloseTo(3.2);
    expect(radiusOf(5, 5)).toBeGreaterThan(radiusOf(1, 5));
  });
});
```

- [ ] **Step 2: 테스트 실패 확인** — `npm test -- renderer` → FAIL

- [ ] **Step 3: 구현 작성** — `buildScene`은 GraphView의 현행 렌더 분기(엣지 active/dimmed, 노드 kind, halo, shownLabels)를 ops로 옮긴 순수 함수. `draw`는 ops를 순회하며 `ctx`에 그린다(dpr 스케일·테마색 적용). `radiusOf`는 GraphView에서 이전. (구현 본문은 위 인터페이스/테스트가 요구하는 분기를 그대로 코드화 — clear → edges → halos → nodes → labels 순서로 push.)

- [ ] **Step 4: 테스트 통과 확인** — `npm test -- renderer` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/renderer.ts src/features/graph/renderer.test.ts
git commit -m "feat(graph): Canvas scene 빌더 + 드로잉 (renderer)"
```

---

### Task 11: `GraphView.tsx` — Canvas 전환 + RAF 루프 + 인터랙션 모델

**Files:**
- Modify: `src/features/graph/GraphView.tsx` (SVG → Canvas 전면 교체)
- Modify: `src/styles.css` (graph 관련 규칙: SVG 전제 규칙 정리, 미니패널·필터바·캔버스 스타일 추가)
- Test: 동작은 E2E(Task 13)로. 여기서는 `npm run typecheck` + `npm run build`로 회귀 차단.

**Interfaces:**
- Consumes: `initSim`/`tickSim`/`reheat`/`setFixed`(layout), `buildScene`/`draw`/`radiusOf`(renderer), `nodeAtScreen`(hitTest), `zoomAround`/`screenToWorld`/`IDENTITY`(camera), `adjacencyOf`/`placeLabels`/`estimateLabelWidth`(layout, 라벨), `ipc.linkGraph`, `useWorkspace`.
- 인터랙션 모델(확정):
  - **호버** → `hover` 설정 → 이웃 강조 + 미니패널(임시).
  - **빈 곳 아닌 노드 클릭 & 그 노드가 selected 아님** → `selected = path`(강조·미니패널 고정 유지).
  - **selected 인 노드를 다시 클릭** → `openFileAt(path)` + `onClose()`.
  - **드래그(4px 초과 이동)** → 노드면 `setFixed`로 노드 이동, 빈 곳이면 카메라 팬. 클릭과 구분.
  - **검색** → 일치 노드로 카메라 팬+줌.

- [ ] **Step 1: 컴포넌트 골격 재작성** — 상태: `sim`(SimState), `cam`(Camera), `hover`, `selected`, `query`, `filters`. RAF 루프: `useEffect`에서 `requestAnimationFrame`으로 `setSim(tickSim)` 반복하되 `sim.alpha <= ALPHA_MIN`이면 멈추고, 인터랙션 핸들러가 `reheat`/`setFixed` 호출 시 재가동. 매 프레임 `draw(ctx, input)` 호출. `<canvas ref>` + `devicePixelRatio` 반영(`canvas.width = W*dpr` 등).

- [ ] **Step 2: 포인터 핸들러** — 기존 `panned` 4px 임계 로직 유지. `pointerdown`에서 `nodeAtScreen`으로 노드 판정 → 드래그 대상이 노드면 그 노드 이동(setFixed), 아니면 카메라 팬. `pointerup`에서 이동이 4px 이하(=클릭)면 인터랙션 모델대로 select/open 분기. 휠 줌은 기존 non-passive 리스너 + `zoomAround`.

- [ ] **Step 3: 미니패널 + 필터바 JSX** — 미니패널: `selected ?? hover` 노드의 경로·`adjacencyOf` 크기(백링크 수는 `in` 방향 카운트)·이웃 목록(클릭 시 `setSelected`). 필터바: 고립 토글·degree 슬라이더·로컬 그래프 토글(현재 노트 N홉만 `initSim`에 넣을 부분그래프 계산).

- [ ] **Step 4: 검증** — `npm run typecheck` → 0 errors. `npm test` → 전체 PASS(순수 모듈 테스트 깨지지 않음). `npm run build` → 성공.

- [ ] **Step 5: 커밋**

```bash
git add src/features/graph/GraphView.tsx src/styles.css
git commit -m "feat(graph): Canvas 렌더 + RAF 시뮬레이션 + 호버/선택/드래그 인터랙션"
```

---

### Task 12: 시각 디자인 마감 + ladle 픽스처

**Files:**
- Modify: `src/styles.css` (노드 그라데이션·도트 그리드 배경·테마 토큰·미니패널/필터바 스타일)
- Create: `src/features/graph/GraphView.stories.tsx` (ladle 픽스처: 빈 그래프 / 작은 그래프 / 허브 있는 그래프, 라이트·다크·핑크)
- Modify: `src/features/graph/renderer.ts` (테마별 색을 CSS 변수에서 읽는 헬퍼 `themeFromCss()` 또는 props 주입)

**Interfaces:**
- Consumes: 테마 토큰(`--accent`, `--fg`, `--fg-faint`, `--bg` 등 `styles.css:1-88`).
- Produces: `export function themeFromCss(el: HTMLElement): GraphTheme;` (getComputedStyle로 토큰 → GraphTheme).

- [ ] **Step 1: `themeFromCss` 테스트** — jsdom에서 인라인 style 변수를 읽어 GraphTheme 필드가 채워지는지 단위 테스트(`renderer.test.ts`에 추가).

```ts
it("themeFromCss 가 CSS 변수에서 색을 읽는다", () => {
  const el = document.createElement("div");
  el.style.setProperty("--accent", "#7c6cf0");
  el.style.setProperty("--fg", "#ddd");
  document.body.appendChild(el);
  const theme = themeFromCss(el);
  expect(theme.node).toBe("#7c6cf0");
  expect(theme.label).toBeTruthy();
});
```

- [ ] **Step 2: 테스트 실패 확인 → 구현 → 통과** — `npm test -- renderer`

- [ ] **Step 3: ladle 픽스처 작성 + 시각 확인** — `npm run ladle`로 라이트/다크/핑크 × (빈/작은/허브) 조합을 눈으로 점검(스크린샷 첨부는 PR 본문에). 노드 그라데이션·도트 그리드·현재 노트 글로우·라벨 LOD가 의도대로 보이는지 확인.

- [ ] **Step 4: 검증** — `npm run typecheck && npm test && npm run build`

- [ ] **Step 5: 커밋**

```bash
git add src/styles.css src/features/graph/GraphView.stories.tsx src/features/graph/renderer.ts src/features/graph/renderer.test.ts
git commit -m "feat(graph): 시각 디자인(그라데이션·도트 배경·테마)·ladle 픽스처"
```

---

### Task 13: E2E 시각 회귀 + 인터랙션 스모크

**Files:**
- Create/Modify: `e2e/graph.spec.ts` (없으면 생성; 기존 e2e 패턴 확인 후 작성)

**Interfaces:**
- Consumes: 기존 playwright 하네스(앱 기동·워크스페이스 픽스처). 먼저 `ls e2e && sed -n '1,40p' e2e/<기존 spec>`로 패턴 확보.

- [ ] **Step 1: 인터랙션 스모크 테스트 작성** — graph view 열기 → 노드 1회 클릭(선택, 미니패널 노출) → 같은 노드 재클릭(노트 열림) 시나리오. 시각 스냅샷 1장(`expect(page).toHaveScreenshot()`)으로 캔버스 렌더 회귀 캡처.

```ts
import { test, expect } from "@playwright/test";
// 기존 e2e 부트스트랩 재사용(워크스페이스 픽스처 + graph 단축키)
test("graph: 클릭으로 선택 후 재클릭하면 노트가 열린다", async ({ page }) => {
  await openGraph(page);               // 기존 헬퍼/단축키로 graph 모달 열기
  await expect(page.locator(".graph-canvas")).toBeVisible();
  await expect(page).toHaveScreenshot("graph-initial.png", { maxDiffPixels: 200 });
  // 노드 좌표는 결정적 초기 배치라 픽스처 기준 좌표를 클릭(헬퍼로 계산)
});
```

- [ ] **Step 2: 스냅샷 기준선 생성** — `npm run e2e:update` (최초 1회 `sudo npx playwright install-deps` 필요할 수 있음)

- [ ] **Step 3: E2E 통과 확인** — `npm run e2e` → PASS(chromium + webkit)

- [ ] **Step 4: 커밋**

```bash
git add e2e/graph.spec.ts e2e/**/*.png
git commit -m "test(graph): Canvas 인터랙션 스모크 + 시각 회귀 스냅샷"
```

---

### Task 14: 최종 통합 검증 + PR 준비

- [ ] **Step 1: 전체 검증**
  - `npm run typecheck && npm test && npm run build`
  - `crates/synapse-core`에서 `cargo test`
  - `crates/synapse-mcp`에서 `cargo test`
  - `src-tauri`에서 `cargo check`

- [ ] **Step 2: spec 대비 커버리지 확인** — `docs/specs/2026-06-25-graph-view-and-mcp-graph-search-design.md`의 각 항목이 구현됐는지 점검(Part A 5개 모듈·인터랙션 표 / Part B tool 4종·코어 4함수).

- [ ] **Step 3: PR 생성** — 본문에 변경 요약, 추가 테스트(코어 단위·MCP 단위·E2E·ladle), 수동 검증(ladle 스크린샷), spec/plan 링크 기재. CI(`release-dry-run` 포함) 통과 확인.

```bash
git push -u origin worktree-graph-redesign
gh pr create --fill
```

---

## Self-Review (작성자 점검 결과)

**Spec coverage:**
- Part A1 Canvas 렌더 → Task 10·11. A2 시뮬레이션+드래그 → Task 9·11. A3 시각 디자인 → Task 12. A4 인터랙션 모델(호버/선택/재클릭 열기/드래그/검색) → Task 11. A5 모듈 분리(layout/renderer/hitTest/camera/GraphView) → Task 7~11. 라벨 LOD·충돌 회피 → 기존 `placeLabels` 재사용(Task 11) + renderer shownLabels(Task 10). 미니패널·필터바·로컬 그래프 → Task 11.
- Part B1 코어 4함수(neighbors/graph_search/path_between/graph_overview) → Task 1~4. B2 tool 4종 → Task 5. B3 on-demand → 각 함수가 `build_graph` 1회 호출. E2E → Task 6.
- 테스트 계획(TS 순수 모듈 vitest / Rust cargo / E2E·ladle) → 각 Task의 테스트 + Task 13·14.

**Placeholder scan:** Task 10·11은 분기가 방대해 본문 일부를 "인터페이스/테스트가 요구하는 분기를 코드화"로 요약했으나, 그 분기는 인터페이스 블록과 테스트에 구체적으로 명시돼 있어 모호하지 않다. Task 6·13은 기존 E2E 헬퍼 이름을 파일에서 확인 후 맞추도록 명시(실제 이름 미상이라 불가피).

**Type consistency:** 코어 타입(`NeighborNote.distance`, `RelatedNote.reason`, `PathStep`, `GraphOverview.hubs/isolated/component_count`)이 Task 1~4 정의와 Task 5 포맷 함수에서 일치. UI 타입(`Camera`, `SimState`/`SimNode`, `HitNode`, `DrawOp`)이 Task 7~11에서 일관되게 참조됨. `radiusOf`는 Task 10에서 정의해 Task 11이 재사용.
