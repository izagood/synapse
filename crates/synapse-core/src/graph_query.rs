//! 링크 그래프 위에서의 쿼리(이웃/검색/경로/구조). build_graph를 재사용하는 순수 로직.
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io;
use std::path::Path;

use serde::Serialize;

use crate::links::{build_graph, LinkGraph};
use crate::retrieval::{extract_keywords, RetrievalOptions};
use crate::search::{search_workspace, SearchOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborNote {
    pub path: String,
    pub name: String,
    pub distance: usize,
}

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
    Adjacency {
        paths,
        names,
        out,
        in_,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedNote {
    pub path: String,
    pub name: String,
    pub score: u32,
    pub reason: String, // "keyword" | "neighbor"
    pub snippet: String,
}

/// 키워드 검색으로 시드 노트를 찾고, hops 만큼 링크(양방향)를 따라 이웃을 보강한다.
/// 점수: 직접 매칭 노트 = 매칭 키워드 수 * 10, 이웃 = (시드 점수 / 2^거리)로 감쇠.
pub fn graph_search(root: &Path, query: &str, hops: usize) -> io::Result<Vec<RelatedNote>> {
    let opts = RetrievalOptions::default();
    let keywords = extract_keywords(query, &opts);
    if keywords.is_empty() {
        return Ok(Vec::new());
    }

    // build_graph는 내부에서 root를 canonicalize하지만 search_workspace는 받은 root를
    // 그대로 노드 경로로 쓴다. 두 경로 표현(특히 Windows의 `\\?\` UNC verbatim)이
    // 어긋나면 index_of 문자열 매칭이 깨지므로, 양쪽에 같은 canonical root를 넘긴다.
    let root = root.canonicalize()?;
    let graph = build_graph(&root)?;
    let adj = adjacency(&graph);

    // 1) 시드: 키워드별 검색 → 노트별 매칭 키워드 수 누적 + 대표 스니펫
    let mut seed_score: HashMap<usize, u32> = HashMap::new();
    let mut snippet: HashMap<usize, String> = HashMap::new();
    let sopts = SearchOptions {
        max_matches_per_file: 1,
        ..SearchOptions::default()
    };
    for kw in &keywords {
        for hit in search_workspace(&root, kw, &sopts) {
            if let Some(i) = adj.index_of(&hit.path) {
                *seed_score.entry(i).or_insert(0) += 10;
                snippet.entry(i).or_insert_with(|| {
                    hit.matches
                        .first()
                        .map(|m| m.snippet.clone())
                        .unwrap_or_default()
                });
            }
        }
    }
    if seed_score.is_empty() {
        return Ok(Vec::new());
    }

    // 2) 이웃 보강: 각 시드에서 hops 만큼 BFS, 미방문 노트에 감쇠 점수
    let mut best: HashMap<usize, (u32, String)> = HashMap::new(); // idx → (score, reason)
    for (&seed, &sc) in &seed_score {
        best.insert(seed, (sc, "keyword".to_string()));
    }
    for (&seed, &sc) in &seed_score {
        let mut dist = vec![usize::MAX; adj.paths.len()];
        let mut q = VecDeque::new();
        dist[seed] = 0;
        q.push_back(seed);
        while let Some(u) = q.pop_front() {
            if dist[u] >= hops {
                continue;
            }
            for &v in adj.out[u].iter().chain(adj.in_[u].iter()) {
                if dist[v] == usize::MAX {
                    dist[v] = dist[u] + 1;
                    let decayed = sc >> dist[v]; // /2^거리
                                                 // 감쇠로 0 이 된 이웃은 의미 있는 점수가 아니므로 추가하지 않는다.
                                                 // (거리>=4, 시드 점수 10 이면 0 → score=0 항목이 출력에 새는 것을 막음)
                    if decayed > 0 && !seed_score.contains_key(&v) {
                        let entry = best.entry(v).or_insert((0, "neighbor".to_string()));
                        if decayed > entry.0 {
                            *entry = (decayed, "neighbor".to_string());
                        }
                    }
                    q.push_back(v);
                }
            }
        }
    }

    let mut out: Vec<RelatedNote> = best
        .into_iter()
        .map(|(i, (score, reason))| RelatedNote {
            path: adj.paths[i].clone(),
            name: adj.names[i].clone(),
            score,
            reason,
            snippet: snippet.get(&i).cloned().unwrap_or_default(),
        })
        .collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.path.cmp(&b.path)));
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStep {
    pub path: String,
    pub name: String,
}

/// BFS로 target에서 depth 홉 이내 이웃을 거리와 함께 모은다. 자기 자신 제외.
pub fn neighbors(
    root: &Path,
    target: &Path,
    dir: Direction,
    depth: usize,
) -> io::Result<Vec<NeighborNote>> {
    let graph = build_graph(root)?;
    let adj = adjacency(&graph);
    let start_path = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf())
        .display()
        .to_string();
    let Some(start) = adj.index_of(&start_path) else {
        return Ok(Vec::new());
    };

    let mut dist = vec![usize::MAX; adj.paths.len()];
    let mut q = VecDeque::new();
    dist[start] = 0;
    q.push_back(start);
    let mut out = Vec::new();
    while let Some(u) = q.pop_front() {
        if dist[u] >= depth {
            continue;
        }
        let mut nexts: Vec<usize> = Vec::new();
        if matches!(dir, Direction::Out | Direction::Both) {
            nexts.extend(&adj.out[u]);
        }
        if matches!(dir, Direction::In | Direction::Both) {
            nexts.extend(&adj.in_[u]);
        }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubNote {
    pub path: String,
    pub name: String,
    pub degree: usize,
}

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
    let degree: Vec<usize> = (0..n)
        .map(|i| adj.out[i].len() + adj.in_[i].len())
        .collect();

    let mut hubs: Vec<HubNote> = (0..n)
        .filter(|&i| degree[i] > 0)
        .map(|i| HubNote {
            path: adj.paths[i].clone(),
            name: adj.names[i].clone(),
            degree: degree[i],
        })
        .collect();
    hubs.sort_by(|a, b| b.degree.cmp(&a.degree).then(a.path.cmp(&b.path)));
    hubs.truncate(OVERVIEW_TOP_HUBS);

    let isolated: Vec<String> = (0..n)
        .filter(|&i| degree[i] == 0)
        .map(|i| adj.paths[i].clone())
        .collect();

    // 연결 컴포넌트 수(무방향 union-find)
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, x: usize) -> usize {
        if p[x] != x {
            let r = find(p, p[x]);
            p[x] = r;
        }
        p[x]
    }
    for u in 0..n {
        for &v in &adj.out[u] {
            let (ru, rv) = (find(&mut parent, u), find(&mut parent, v));
            if ru != rv {
                parent[ru] = rv;
            }
        }
    }
    let component_count = (0..n).filter(|&i| find(&mut parent, i) == i).count();

    Ok(GraphOverview {
        node_count: n,
        edge_count: graph.edges.len(),
        hubs,
        isolated,
        component_count,
    })
}

/// from→to 최단 연결 경로(엣지를 양방향으로 취급). 경로 없으면 None.
pub fn path_between(root: &Path, from: &Path, to: &Path) -> io::Result<Option<Vec<PathStep>>> {
    let graph = build_graph(root)?;
    let adj = adjacency(&graph);
    let abs = |p: &Path| {
        p.canonicalize()
            .unwrap_or_else(|_| p.to_path_buf())
            .display()
            .to_string()
    };
    let (Some(s), Some(t)) = (adj.index_of(&abs(from)), adj.index_of(&abs(to))) else {
        return Ok(None);
    };
    if s == t {
        return Ok(Some(vec![PathStep {
            path: adj.paths[s].clone(),
            name: adj.names[s].clone(),
        }]));
    }

    let mut prev = vec![usize::MAX; adj.paths.len()];
    let mut seen = vec![false; adj.paths.len()];
    let mut q = VecDeque::new();
    seen[s] = true;
    q.push_back(s);
    while let Some(u) = q.pop_front() {
        for &v in adj.out[u].iter().chain(adj.in_[u].iter()) {
            if !seen[v] {
                seen[v] = true;
                prev[v] = u;
                q.push_back(v);
                if v == t {
                    let mut chain = vec![t];
                    let mut cur = t;
                    while cur != s {
                        cur = prev[cur];
                        chain.push(cur);
                    }
                    chain.reverse();
                    return Ok(Some(
                        chain
                            .into_iter()
                            .map(|i| PathStep {
                                path: adj.paths[i].clone(),
                                name: adj.names[i].clone(),
                            })
                            .collect(),
                    ));
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn overview_reports_hubs_isolated_and_components() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::write(root.join("hub.md"), "[a](a.md) [b](b.md)").unwrap(); // degree 2 (out)
        fs::write(root.join("a.md"), "back [[hub]]").unwrap();
        fs::write(root.join("b.md"), "leaf").unwrap();
        fs::write(root.join("lone.md"), "고립").unwrap(); // degree 0
        let ov = graph_overview(&root).unwrap();
        assert_eq!(ov.node_count, 4);
        assert_eq!(ov.hubs.first().unwrap().name, "hub.md");
        assert!(ov.isolated.iter().any(|p| p.ends_with("lone.md")));
        assert_eq!(ov.component_count, 2); // {hub,a,b} 와 {lone}
    }

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
        assert_eq!(
            got.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
            ["b.md"]
        );
        assert_eq!(got[0].distance, 1);
    }

    #[test]
    fn neighbors_in_finds_backlinks() {
        let (_d, root) = fixture();
        let got = neighbors(&root, &root.join("b.md"), Direction::In, 1).unwrap();
        assert_eq!(
            got.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
            ["a.md"]
        );
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
        assert!(names.contains(&"hub.md")); // 키워드 직접 매칭
        assert!(names.contains(&"related.md")); // 링크 이웃 보강
        assert!(!names.contains(&"noise.md"));
        // 직접 매칭이 이웃보다 점수가 높다
        let hub = got.iter().find(|n| n.name == "hub.md").unwrap();
        let rel = got.iter().find(|n| n.name == "related.md").unwrap();
        assert!(hub.score > rel.score);
        assert_eq!(hub.reason, "keyword");
        assert_eq!(rel.reason, "neighbor");
    }

    #[test]
    fn graph_search_excludes_decayed_zero_neighbors() {
        // seed(키워드 매칭) → n1 → n2 → n3 → n4 사슬.
        // 시드 점수 10 기준 감쇠: n1=5, n2=2, n3=1, n4=0.
        // hops 를 넉넉히(5) 줘도 n4 는 score=0 이라 출력에서 빠져야 한다.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::write(root.join("seed.md"), "rust 그래프 알고리즘 [[n1]]").unwrap();
        fs::write(root.join("n1.md"), "[[n2]]").unwrap();
        fs::write(root.join("n2.md"), "[[n3]]").unwrap();
        fs::write(root.join("n3.md"), "[[n4]]").unwrap();
        fs::write(root.join("n4.md"), "leaf").unwrap();
        let got = graph_search(&root, "그래프", 5).unwrap();
        let names: Vec<_> = got.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"seed.md")); // 키워드 직접 매칭
        assert!(names.contains(&"n1.md")); // 1홉, score 5
        assert!(names.contains(&"n2.md")); // 2홉, score 2
        assert!(names.contains(&"n3.md")); // 3홉, score 1
        assert!(!names.contains(&"n4.md")); // 4홉, score 0 → 제외
                                            // 살아남은 이웃은 모두 양수 점수
        for n in &got {
            assert!(n.score > 0, "{} 의 점수가 0", n.name);
        }
    }

    #[test]
    fn graph_search_empty_query_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(graph_search(dir.path(), "  ", 1).unwrap().is_empty());
    }

    #[test]
    fn path_between_finds_shortest_chain() {
        let (_d, root) = fixture(); // a→b→c
        let p = path_between(&root, &root.join("a.md"), &root.join("c.md"))
            .unwrap()
            .unwrap();
        assert_eq!(
            p.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["a.md", "b.md", "c.md"]
        );
    }

    #[test]
    fn path_between_returns_none_when_disconnected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::write(root.join("x.md"), "lone").unwrap();
        fs::write(root.join("y.md"), "lone").unwrap();
        assert!(path_between(&root, &root.join("x.md"), &root.join("y.md"))
            .unwrap()
            .is_none());
    }
}
