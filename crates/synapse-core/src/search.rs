//! 워크스페이스 전체 텍스트 검색 (FR-1.5).
//!
//! "진실의 원천은 파일시스템" 원칙대로 인덱스를 두지 않고 요청 시 폴더를 순회하며
//! 매칭한다(on-demand). 대용량 워크스페이스에서 한계가 보이면 인덱스(tantivy 등)를
//! 2차로 검토한다. 파일명과 내용을 모두 매칭하고, 숨김 항목·심볼릭 링크·바이너리
//! 파일은 건너뛴다(tree.rs와 동일한 정책).

use std::fs;
use std::path::Path;

use serde::Serialize;

/// 내용 검색 대상 텍스트 확장자. 그 외 파일은 파일명만 매칭한다.
const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "mdx", "txt", "html", "htm"];

/// 한 파일 안의 매치 한 건.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based 줄 번호.
    pub line: u32,
    /// 매치가 포함된 줄(앞뒤 공백 정리 + 길이 제한).
    pub snippet: String,
}

/// 파일 한 건의 검색 결과.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    /// 파일명 자체가 질의와 일치했는지.
    pub name_match: bool,
    /// 내용 매치(최대 `max_matches_per_file`건).
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    /// 결과 파일 수 상한.
    pub max_results: usize,
    /// 파일당 내용 매치 상한.
    pub max_matches_per_file: usize,
    /// 내용을 읽어 검색할 파일 크기 상한(바이트). 초과 파일은 파일명만 매칭.
    pub max_file_bytes: u64,
    /// 스니펫 최대 길이(문자).
    pub max_snippet_chars: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            case_sensitive: false,
            max_results: 200,
            max_matches_per_file: 20,
            max_file_bytes: 2 * 1024 * 1024, // 2MB
            max_snippet_chars: 200,
        }
    }
}

/// 워크스페이스를 순회하며 파일명·내용을 검색한다. 질의가 비어 있으면 빈 결과.
pub fn search_workspace(root: &Path, query: &str, opts: &SearchOptions) -> Vec<SearchHit> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let needle = if opts.case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let mut hits = Vec::new();
    walk(root, &needle, opts, &mut hits);
    hits
}

fn walk(dir: &Path, needle: &str, opts: &SearchOptions, hits: &mut Vec<SearchHit>) {
    if hits.len() >= opts.max_results {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    // 디렉토리를 결정적 순서로 순회해 결과가 안정적이도록 정렬한다.
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if hits.len() >= opts.max_results {
            return;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // 숨김 항목(.git 포함)은 건너뛴다 (FR-1.6, tree.rs와 동일).
        if name.starts_with('.') {
            continue;
        }
        // 심볼릭 링크는 따라가지 않는다(순환 방지).
        let ft = match path.symlink_metadata() {
            Ok(m) => m.file_type(),
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(&path, needle, opts, hits);
        } else if ft.is_file() {
            if let Some(hit) = match_file(&path, &name, needle, opts) {
                hits.push(hit);
            }
        }
    }
}

fn match_file(path: &Path, name: &str, needle: &str, opts: &SearchOptions) -> Option<SearchHit> {
    let haystack_name = if opts.case_sensitive {
        name.to_string()
    } else {
        name.to_lowercase()
    };
    let name_match = haystack_name.contains(needle);

    let matches = if is_searchable_text(path, opts) {
        search_content(path, needle, opts)
    } else {
        Vec::new()
    };

    if name_match || !matches.is_empty() {
        Some(SearchHit {
            path: path.display().to_string(),
            name: name.to_string(),
            name_match,
            matches,
        })
    } else {
        None
    }
}

fn is_searchable_text(path: &Path, opts: &SearchOptions) -> bool {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|e| TEXT_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or(false);
    if !ext_ok {
        return false;
    }
    match path.metadata() {
        Ok(m) => m.len() <= opts.max_file_bytes,
        Err(_) => false,
    }
}

fn search_content(path: &Path, needle: &str, opts: &SearchOptions) -> Vec<SearchMatch> {
    // utf-8로 읽히지 않으면(바이너리) 내용 검색을 건너뛴다.
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut matches = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if matches.len() >= opts.max_matches_per_file {
            break;
        }
        let haystack = if opts.case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };
        if let Some(col) = haystack.find(needle) {
            matches.push(SearchMatch {
                line: (i + 1) as u32,
                snippet: make_snippet(line, col, needle.len(), opts.max_snippet_chars),
            });
        }
    }
    matches
}

/// 매치 위치를 중심으로 긴 줄을 잘라 스니펫을 만든다. char 경계를 지킨다.
fn make_snippet(line: &str, match_byte: usize, needle_len: usize, max_chars: usize) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    // 매치 시작의 문자 인덱스를 구한다(바이트→문자).
    let match_char = line[..match_byte].chars().count();
    let needle_chars = line[match_byte..]
        .char_indices()
        .take_while(|(b, _)| *b < needle_len)
        .count()
        .max(1);
    let chars: Vec<char> = line.chars().collect();
    let half = max_chars.saturating_sub(needle_chars) / 2;
    let start = match_char.saturating_sub(half);
    let end = (start + max_chars).min(chars.len());
    let start = end.saturating_sub(max_chars).min(start);
    let middle: String = chars[start..end].iter().collect();
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(middle.trim());
    if end < chars.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    fn write(path: &Path, content: &str) {
        let mut f = File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    fn opts() -> SearchOptions {
        SearchOptions::default()
    }

    #[test]
    fn matches_content_with_line_numbers() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join("note.md"),
            "first line\nsecond has needle here\nthird line\n",
        );
        let hits = search_workspace(tmp.path(), "needle", &opts());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "note.md");
        assert_eq!(hits[0].matches.len(), 1);
        assert_eq!(hits[0].matches[0].line, 2);
        assert!(hits[0].matches[0].snippet.contains("needle"));
    }

    #[test]
    fn matches_filename_even_without_content_match() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("shopping-needle.md"), "nothing relevant\n");
        let hits = search_workspace(tmp.path(), "needle", &opts());
        assert_eq!(hits.len(), 1);
        assert!(hits[0].name_match);
        assert!(hits[0].matches.is_empty());
    }

    #[test]
    fn case_insensitive_by_default_and_sensitive_when_opted() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a.md"), "Has NeEdLe inside\n");
        assert_eq!(search_workspace(tmp.path(), "needle", &opts()).len(), 1);

        let sensitive = SearchOptions {
            case_sensitive: true,
            ..Default::default()
        };
        assert_eq!(search_workspace(tmp.path(), "needle", &sensitive).len(), 0);
        assert_eq!(search_workspace(tmp.path(), "NeEdLe", &sensitive).len(), 1);
    }

    #[test]
    fn skips_hidden_and_git() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        write(&tmp.path().join(".git/config.md"), "needle in git\n");
        write(&tmp.path().join(".hidden.md"), "needle hidden\n");
        write(&tmp.path().join("visible.md"), "needle visible\n");
        let hits = search_workspace(tmp.path(), "needle", &opts());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "visible.md");
    }

    #[test]
    fn recurses_into_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        write(&tmp.path().join("sub/deep.md"), "needle deep\n");
        let hits = search_workspace(tmp.path(), "needle", &opts());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "deep.md");
    }

    #[test]
    fn ignores_binary_and_non_text_content() {
        let tmp = tempfile::tempdir().unwrap();
        // 비텍스트 확장자: 내용 검색 안 함. 파일명 매치도 없음.
        write(&tmp.path().join("image.png"), "needle but png\n");
        let hits = search_workspace(tmp.path(), "needle", &opts());
        assert!(hits.is_empty());
    }

    #[test]
    fn empty_query_returns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a.md"), "needle\n");
        assert!(search_workspace(tmp.path(), "   ", &opts()).is_empty());
    }

    #[test]
    fn respects_max_results() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..5 {
            write(&tmp.path().join(format!("n{i}.md")), "needle\n");
        }
        let capped = SearchOptions {
            max_results: 3,
            ..Default::default()
        };
        assert_eq!(search_workspace(tmp.path(), "needle", &capped).len(), 3);
    }

    #[test]
    fn caps_matches_per_file() {
        let tmp = tempfile::tempdir().unwrap();
        let body = "needle\n".repeat(50);
        write(&tmp.path().join("many.md"), &body);
        let capped = SearchOptions {
            max_matches_per_file: 4,
            ..Default::default()
        };
        let hits = search_workspace(tmp.path(), "needle", &capped);
        assert_eq!(hits[0].matches.len(), 4);
    }

    #[test]
    fn long_line_snippet_is_truncated_around_match() {
        let tmp = tempfile::tempdir().unwrap();
        let line = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        write(&tmp.path().join("long.md"), &line);
        let hits = search_workspace(tmp.path(), "needle", &opts());
        let snippet = &hits[0].matches[0].snippet;
        assert!(snippet.contains("needle"));
        assert!(snippet.chars().count() <= 202); // max_snippet_chars + 양끝 줄임표
        assert!(snippet.starts_with('…'));
        assert!(snippet.ends_with('…'));
    }
}
