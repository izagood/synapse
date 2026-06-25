//! 링크 그래프 위에서의 쿼리(이웃/검색/경로/구조). build_graph를 재사용하는 순수 로직.
use std::collections::VecDeque;
use std::io;
use std::path::Path;

use serde::Serialize;

use crate::links::{build_graph, LinkGraph};

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
