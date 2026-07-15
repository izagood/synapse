//! "내 노트에게 묻기" 검색 기반 retrieval (2-C v1).
//!
//! 임베딩 백엔드가 정해지기 전까지는 이미 머지된 검색 인프라(`search.rs`)와
//! 링크 그래프(`links.rs`)만 재사용해 retrieval-augmented 컨텍스트를 만든다.
//!
//! 흐름:
//! 1. 질문에서 키워드를 뽑는다(짧은 토큰·불용어 제거).
//! 2. 키워드별로 `search_workspace`를 돌려 매칭 노트를 모으고,
//!    매칭 키워드 수·파일명 매칭 여부로 노트 점수를 매긴다.
//! 3. 상위 노트의 백링크(`backlinks_for`)로 인접 노트를 보강한다.
//! 4. 상위 N개 노트에서 대표 스니펫을 골라 출처 메타와 함께 돌려준다.
//!
//! 임베딩 기반 의미 검색은 2차 과제다. 여기서는 키워드 매칭만 한다.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::links::backlinks_for;
use crate::search::{search_workspace, SearchOptions};

/// 답변 근거로 쓸 노트 한 건의 스니펫과 출처 메타.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedSnippet {
    /// 노트 절대 경로(출처 라벨 + 클릭 시 열기용).
    pub path: String,
    /// 파일명(표시용).
    pub name: String,
    /// 대표 스니펫(여러 매치 줄을 합친 것). 백링크 보강 노트는 비어 있을 수 있다.
    pub snippet: String,
    /// 이 노트가 직접 검색에 걸렸는지(false면 백링크로 보강된 인접 노트).
    pub direct_match: bool,
    /// 랭킹 점수(디버깅·정렬 안정성용).
    pub score: u32,
}

/// retrieval 결과 전체.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    /// 질문에서 뽑은 키워드(빈 질문이면 비어 있음).
    pub keywords: Vec<String>,
    /// 점수순 상위 스니펫.
    pub snippets: Vec<RetrievedSnippet>,
}

/// retrieval 튜닝 옵션.
#[derive(Debug, Clone)]
pub struct RetrievalOptions {
    /// 최종 스니펫(노트) 최대 개수.
    pub max_snippets: usize,
    /// 백링크로 인접 노트를 보강할 상위 노트 수.
    pub expand_top_n: usize,
    /// 한 노트의 대표 스니펫에 합칠 매치 줄 최대 수.
    pub max_lines_per_snippet: usize,
    /// 키워드 최소 길이(이보다 짧은 토큰은 버린다). 한글 등 멀티바이트는 char 기준.
    pub min_keyword_chars: usize,
    /// 질문에서 뽑을 키워드 최대 개수.
    pub max_keywords: usize,
    /// 키워드당 search.rs 검색 옵션.
    pub search: SearchOptions,
}

impl Default for RetrievalOptions {
    fn default() -> Self {
        RetrievalOptions {
            max_snippets: 6,
            expand_top_n: 3,
            max_lines_per_snippet: 3,
            min_keyword_chars: 2,
            max_keywords: 8,
            search: SearchOptions {
                // retrieval은 노트 수만 추리면 되므로 파일당 매치는 적게.
                max_matches_per_file: 5,
                ..SearchOptions::default()
            },
        }
    }
}

/// 영어 불용어(소문자). 한국어 조사는 토큰 분리상 따로 떼기 어려워 길이로만 거른다.
pub(crate) const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "was", "were", "with", "that", "this", "from", "what", "which",
    "how", "why", "who", "when", "where", "about", "into", "your", "you", "our", "can", "could",
    "would", "should", "does", "did", "has", "have", "had", "will", "shall", "not", "but", "all",
    "any", "its", "his", "her", "their", "them", "they",
];

/// 질문에서 검색 키워드를 뽑는다. 영숫자/한글 등 "단어 문자"로 토큰을 끊고,
/// 너무 짧은 토큰·영어 불용어·중복은 버린다. 등장 순서를 보존한다.
pub fn extract_keywords(question: &str, opts: &RetrievalOptions) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in question.split(|c: char| !c.is_alphanumeric()) {
        if raw.is_empty() {
            continue;
        }
        let lower = raw.to_lowercase();
        if lower.chars().count() < opts.min_keyword_chars {
            continue;
        }
        if STOPWORDS.contains(&lower.as_str()) {
            continue;
        }
        if seen.insert(lower.clone()) {
            out.push(lower);
            if out.len() >= opts.max_keywords {
                break;
            }
        }
    }
    out
}

/// 한 노트의 누적 검색 상태.
struct NoteAcc {
    name: String,
    /// 이 노트에 매칭된 서로 다른 키워드 수.
    matched_keywords: std::collections::HashSet<String>,
    /// 파일명이 어떤 키워드와 매칭됐는지.
    name_match: bool,
    /// 대표 스니펫에 쓸 매치 줄(중복 제거, 등장 순서).
    lines: Vec<String>,
    seen_lines: std::collections::HashSet<String>,
}

impl NoteAcc {
    fn new(name: String) -> Self {
        NoteAcc {
            name,
            matched_keywords: std::collections::HashSet::new(),
            name_match: false,
            lines: Vec::new(),
            seen_lines: std::collections::HashSet::new(),
        }
    }

    /// 점수: 매칭 키워드 수가 주(主), 파일명 매칭은 가산점.
    fn score(&self) -> u32 {
        let kw = self.matched_keywords.len() as u32;
        kw * 10 + if self.name_match { 5 } else { 0 } + self.lines.len().min(3) as u32
    }
}

/// 질문에 대해 워크스페이스에서 관련 노트 스니펫을 retrieval한다(순수 함수).
///
/// `root` 아래만 읽으며 디스크에 쓰지 않는다. 결정적 순서를 보장한다.
pub fn retrieve_context(root: &Path, question: &str, opts: &RetrievalOptions) -> RetrievalResult {
    let keywords = extract_keywords(question, opts);
    if keywords.is_empty() {
        return RetrievalResult {
            keywords,
            snippets: Vec::new(),
        };
    }

    // 경로 → 누적 상태. 결정적 순서를 위해 정렬 키로 path를 쓴다.
    let mut notes: HashMap<String, NoteAcc> = HashMap::new();

    for kw in &keywords {
        for hit in search_workspace(root, kw, &opts.search) {
            let acc = notes
                .entry(hit.path.clone())
                .or_insert_with(|| NoteAcc::new(hit.name.clone()));
            acc.matched_keywords.insert(kw.clone());
            if hit.name_match {
                acc.name_match = true;
            }
            for m in &hit.matches {
                if acc.lines.len() >= opts.max_lines_per_snippet {
                    break;
                }
                if acc.seen_lines.insert(m.snippet.clone()) {
                    acc.lines.push(m.snippet.clone());
                }
            }
        }
    }

    // 직접 매칭 노트를 점수순으로 정렬(동점은 경로순으로 안정화).
    let mut direct: Vec<(String, u32)> =
        notes.iter().map(|(p, a)| (p.clone(), a.score())).collect();
    direct.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // 상위 노트의 백링크로 인접 노트를 보강한다(아직 없는 노트만 추가).
    let expand: Vec<String> = direct
        .iter()
        .take(opts.expand_top_n)
        .map(|(p, _)| p.clone())
        .collect();
    for path in expand {
        let backs = match backlinks_for(root, Path::new(&path)) {
            Ok(b) => b,
            Err(_) => continue,
        };
        for b in backs {
            if notes.contains_key(&b.source_path) {
                continue; // 이미 직접 매칭된 노트는 그대로 둔다
            }
            let acc = notes
                .entry(b.source_path.clone())
                .or_insert_with(|| NoteAcc::new(b.source_name.clone()));
            // 백링크 보강 노트는 매칭 줄 하나(링크가 등장한 줄)만 근거로 둔다.
            if acc.lines.len() < opts.max_lines_per_snippet
                && acc.seen_lines.insert(b.snippet.clone())
            {
                acc.lines.push(b.snippet.clone());
            }
        }
    }

    // 최종 스니펫 빌드. 직접 매칭(키워드 점수 있음)을 백링크 보강보다 우선.
    let mut snippets: Vec<RetrievedSnippet> = notes
        .into_iter()
        .map(|(path, acc)| {
            let direct_match = !acc.matched_keywords.is_empty();
            let score = acc.score();
            RetrievedSnippet {
                path,
                name: acc.name,
                snippet: acc.lines.join("\n"),
                direct_match,
                score,
            }
        })
        .collect();

    snippets.sort_by(|a, b| {
        b.direct_match
            .cmp(&a.direct_match)
            .then_with(|| b.score.cmp(&a.score))
            .then_with(|| a.path.cmp(&b.path))
    });
    snippets.truncate(opts.max_snippets);

    RetrievalResult { keywords, snippets }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::Path;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    fn opts() -> RetrievalOptions {
        RetrievalOptions::default()
    }

    #[test]
    fn extracts_keywords_dropping_short_and_stopwords() {
        let kws = extract_keywords("How does the Rust async runtime work?", &opts());
        // "how","does","the" 불용어, "" 제거. 길이 < 2 없음.
        assert_eq!(kws, vec!["rust", "async", "runtime", "work"]);
    }

    #[test]
    fn keywords_dedup_and_lowercase_preserve_order() {
        let kws = extract_keywords("Rust rust RUST async", &opts());
        assert_eq!(kws, vec!["rust", "async"]);
    }

    #[test]
    fn empty_question_yields_no_snippets() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a.md"), "rust async runtime");
        let r = retrieve_context(tmp.path(), "   ?!  ", &opts());
        assert!(r.keywords.is_empty());
        assert!(r.snippets.is_empty());
    }

    #[test]
    fn ranks_note_matching_more_keywords_higher() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // both: async + tokio 둘 다 / one: async 만
        write(
            &root.join("both.md"),
            "tokio async runtime 설명\n비동기 작업",
        );
        write(&root.join("one.md"), "async 만 있는 노트");
        write(&root.join("none.md"), "관련 없는 내용");

        let r = retrieve_context(root, "tokio async 런타임", &opts());
        assert!(r.keywords.contains(&"tokio".to_string()));
        let names: Vec<&str> = r.snippets.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names[0], "both.md", "두 키워드 매칭 노트가 상위");
        assert!(names.contains(&"one.md"));
        assert!(!names.contains(&"none.md"));
    }

    #[test]
    fn filename_match_boosts_score() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 파일명에 키워드가 있는 노트 vs 내용에만 한 줄.
        write(&root.join("rust-guide.md"), "내용은 짧다");
        write(&root.join("misc.md"), "여기 rust 한 줄");

        let r = retrieve_context(root, "rust", &opts());
        let top = &r.snippets[0];
        assert_eq!(top.name, "rust-guide.md", "파일명 매칭이 가산점");
        assert!(top.direct_match);
    }

    #[test]
    fn snippet_collects_matching_lines_with_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(
            &root.join("note.md"),
            "first\nasync line one\nmiddle\nasync line two\n",
        );
        let r = retrieve_context(root, "async", &opts());
        let s = r.snippets.iter().find(|s| s.name == "note.md").unwrap();
        assert!(s.path.ends_with("note.md"));
        assert!(s.snippet.contains("async line one"));
        assert!(s.snippet.contains("async line two"));
    }

    #[test]
    fn backlinks_expand_neighbors() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // target은 키워드로 직접 매칭. neighbor는 키워드는 없지만 target을 링크.
        write(&root.join("target.md"), "# 핵심\ntokio 런타임 핵심 노트");
        write(&root.join("neighbor.md"), "참고: [핵심](target.md) 을 보라");
        write(&root.join("unrelated.md"), "전혀 다른 주제");

        let r = retrieve_context(root, "tokio", &opts());
        let names: Vec<&str> = r.snippets.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"target.md"), "직접 매칭");
        assert!(names.contains(&"neighbor.md"), "백링크로 보강");
        assert!(!names.contains(&"unrelated.md"));
        // 직접 매칭이 보강 노트보다 앞.
        let target = r.snippets.iter().find(|s| s.name == "target.md").unwrap();
        let neighbor = r.snippets.iter().find(|s| s.name == "neighbor.md").unwrap();
        assert!(target.direct_match);
        assert!(!neighbor.direct_match);
        let ti = r
            .snippets
            .iter()
            .position(|s| s.name == "target.md")
            .unwrap();
        let ni = r
            .snippets
            .iter()
            .position(|s| s.name == "neighbor.md")
            .unwrap();
        assert!(ti < ni, "직접 매칭이 보강보다 앞에 정렬됨");
    }

    #[test]
    fn respects_max_snippets() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for i in 0..10 {
            write(&root.join(format!("n{i}.md")), "async 노트");
        }
        let capped = RetrievalOptions {
            max_snippets: 3,
            ..Default::default()
        };
        let r = retrieve_context(root, "async", &capped);
        assert_eq!(r.snippets.len(), 3);
    }

    #[test]
    fn deterministic_order_for_ties() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("b.md"), "async 한 줄");
        write(&root.join("a.md"), "async 한 줄");
        let r1 = retrieve_context(root, "async", &opts());
        let r2 = retrieve_context(root, "async", &opts());
        assert_eq!(r1, r2);
        // 동점이면 경로(a < b)순.
        let names: Vec<&str> = r1.snippets.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["a.md", "b.md"]);
    }

    #[test]
    fn serializes_camel_case() {
        let r = RetrievalResult {
            keywords: vec!["k".into()],
            snippets: vec![RetrievedSnippet {
                path: "/v/a.md".into(),
                name: "a.md".into(),
                snippet: "x".into(),
                direct_match: true,
                score: 10,
            }],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"directMatch\""));
        assert!(json.contains("\"keywords\""));
    }
}
