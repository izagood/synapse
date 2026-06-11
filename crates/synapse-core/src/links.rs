//! 노트 간 링크 그래프 (FR-2.8 → FR-6.1): 아웃바운드 링크 추출 + 백링크 역인덱스.
//!
//! 두 종류의 링크를 인식한다:
//! 1. 표준 마크다운 링크 `[text](relative/path.md)` — 소스 문서 기준 상대 경로로 해석
//!    (루트 밖 탈출 금지). `internalLink.ts`의 `resolveInternalLink`와 의미가 일관됨.
//! 2. 위키링크 `[[파일명]]` / `[[파일명|별칭]]` — 워크스페이스 내 같은 basename
//!    (확장자 제외)의 `.md` 파일로 해석.
//!
//! 순회 정책은 `tree.rs`와 동일: 숨김 항목(`.`으로 시작, `.git` 포함)·심볼릭 링크 제외.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// 한 소스 문서가 다른 문서를 가리키는 백링크 한 건.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    /// 링크를 가진 소스 문서의 절대 경로
    pub source_path: String,
    /// 소스 문서 파일명 (UI 표시용)
    pub source_name: String,
    /// 링크가 등장한 줄(문맥) 텍스트 — 양끝 공백 제거
    pub snippet: String,
}

/// 마크다운 본문에서 추출한 아웃바운드 링크 한 건.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutLink {
    /// 표준 링크의 raw href (예: "../00-목차.md", "./하위/노트.md#섹션")
    Standard(String),
    /// 위키링크의 대상 이름(확장자·별칭 제외, 예: "00-목차")
    Wiki(String),
}

/// 코드펜스(``` ... ```)·인라인 코드(`...`)를 무시하면서 본문에서 링크를 추출한다.
///
/// 줄 단위로 (링크, 그 줄 텍스트)를 돌려준다. 줄 텍스트는 백링크 스니펫에 쓰인다.
pub fn extract_links(body: &str) -> Vec<(OutLink, String)> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        // 코드펜스 토글 (``` 또는 ~~~)
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        for link in links_in_line(line) {
            out.push((link, line.trim().to_string()));
        }
    }
    out
}

/// 한 줄에서 위키링크와 표준 링크를 추출한다. 인라인 코드(`...`) 안은 무시.
fn links_in_line(line: &str) -> Vec<OutLink> {
    let chars: Vec<char> = line.chars().collect();
    let mut links = Vec::new();
    let mut i = 0;
    let n = chars.len();
    let mut in_code = false;
    while i < n {
        let c = chars[i];
        if c == '`' {
            in_code = !in_code;
            i += 1;
            continue;
        }
        if in_code {
            i += 1;
            continue;
        }
        // 위키링크 [[ ... ]]
        if c == '[' && i + 1 < n && chars[i + 1] == '[' {
            if let Some(end) = find_subseq(&chars, i + 2, "]]") {
                let inner: String = chars[i + 2..end].iter().collect();
                if let Some(name) = wiki_target(&inner) {
                    links.push(OutLink::Wiki(name));
                }
                i = end + 2;
                continue;
            }
        }
        // 표준 링크 [text](href) — 이미지 ![alt](src)는 제외(앞 글자가 '!')
        if c == '[' && !(i > 0 && chars[i - 1] == '!') {
            if let Some(close) = matching_bracket(&chars, i) {
                if close + 1 < n && chars[close + 1] == '(' {
                    if let Some(paren_end) = find_char(&chars, close + 2, ')') {
                        let href: String = chars[close + 2..paren_end].iter().collect();
                        let href = href.trim();
                        if !href.is_empty() {
                            links.push(OutLink::Standard(href.to_string()));
                        }
                        i = paren_end + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    links
}

/// `[[name]]` / `[[name|alias]]` 내부에서 대상 이름을 뽑는다(별칭·앵커 제거).
fn wiki_target(inner: &str) -> Option<String> {
    // 별칭 분리: 첫 '|' 앞이 대상
    let target = inner.split('|').next().unwrap_or("").trim();
    // 앵커(#섹션) 제거
    let target = target.split('#').next().unwrap_or("").trim();
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

/// `chars[from..]`에서 부분 문자열 `needle`이 시작되는 인덱스를 찾는다.
fn find_subseq(chars: &[char], from: usize, needle: &str) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() || from > chars.len() {
        return None;
    }
    let mut i = from;
    while i + needle.len() <= chars.len() {
        if chars[i..i + needle.len()] == needle[..] {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == target)
}

/// `[`(open 위치)에 대응하는 `]`를 중첩을 고려해 찾는다.
fn matching_bracket(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// 표준 링크 href를 소스 문서 기준 절대 경로로 해석한다.
///
/// `internalLink.ts`의 `resolveInternalLink`와 의미를 맞춘다:
/// - 외부 스킴(`http:` 등)·`//`·문서 내 앵커(`#`)는 None
/// - 앵커·쿼리는 떼고 파일 경로만
/// - 선행 `/`는 루트 기준, 그 외에는 소스 문서 폴더 기준
/// - 루트 밖으로 나가면 None
pub fn resolve_standard_link(href: &str, source: &Path, root: &Path) -> Option<PathBuf> {
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    if href.starts_with("//") || has_scheme(href) {
        return None;
    }
    // 앵커·쿼리 제거
    let path_part = href.split(['?', '#']).next().unwrap_or("");
    if path_part.is_empty() {
        return None;
    }
    let decoded = percent_decode(path_part);

    let base: PathBuf = if decoded.starts_with('/') {
        root.to_path_buf()
    } else {
        source.parent().unwrap_or(root).to_path_buf()
    };

    let mut segments: Vec<String> = path_components(&base);
    for part in decoded.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                segments.pop();
            }
            other => segments.push(other.to_string()),
        }
    }
    let resolved = rebuild_path(&base, segments);
    if resolved.starts_with(root) && resolved.as_path() != root {
        Some(resolved)
    } else {
        None
    }
}

fn has_scheme(href: &str) -> bool {
    // [A-Za-z][A-Za-z0-9+.-]*:
    let bytes = href.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    for (idx, &b) in bytes.iter().enumerate() {
        if b == b':' {
            return idx > 0;
        }
        if !(b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-') {
            return false;
        }
    }
    false
}

/// 절대 경로를 루트 접두 + 그 뒤 세그먼트로 분해한다(루트 자체는 보존).
fn path_components(base: &Path) -> Vec<String> {
    base.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

/// 분해된 세그먼트를 절대 경로로 되돌린다. base의 루트(접두사)를 유지한다.
fn rebuild_path(base: &Path, segments: Vec<String>) -> PathBuf {
    let mut result = PathBuf::new();
    // 절대 경로의 루트(`/` 혹은 Windows 접두사)를 먼저 둔다
    for c in base.components() {
        match c {
            Component::Prefix(p) => result.push(p.as_os_str()),
            Component::RootDir => result.push(Component::RootDir.as_os_str()),
            _ => break,
        }
    }
    for s in segments {
        result.push(s);
    }
    result
}

/// 표준 퍼센트 디코딩(UTF-8). 잘못된 입력은 원문 그대로 둔다.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 워크스페이스의 모든 `.md` 파일 절대 경로를 모은다(tree.rs와 같은 순회 정책).
fn collect_markdown(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let ft = entry.path().symlink_metadata()?.file_type();
        let path = entry.path();
        if ft.is_dir() {
            collect_markdown(&path, out)?;
        } else if ft.is_file() && is_markdown(&path) {
            out.push(path);
        }
        // 심볼릭 링크는 제외
    }
    Ok(())
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    )
}

/// 확장자를 뗀 파일명(basename) — 위키링크 해석용.
fn stem(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().into_owned())
}

/// `target`을 가리키는 모든 백링크를 모은다.
///
/// 워크스페이스 전체를 순회하며 각 `.md` 파일의 아웃바운드 링크를 해석해,
/// `target`(절대 경로)을 가리키는 것만 (소스 경로, 줄 스니펫)으로 추려 돌려준다.
/// 자기 자신은 제외한다. 결과는 소스 경로 기준 정렬.
pub fn backlinks_for(root: &Path, target: &Path) -> io::Result<Vec<Backlink>> {
    let root = root.canonicalize()?;
    // target은 아직 없을 수도 있지만, 보통 존재하는 노트다. canonicalize 실패 시 원본 사용.
    let target_abs = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    let target_stem = stem(&target_abs);

    let mut md_files = Vec::new();
    collect_markdown(&root, &mut md_files)?;

    // 위키링크 해석용: basename(소문자) → 절대 경로. 충돌 시 먼저 만난 것 유지.
    let mut by_stem: HashMap<String, PathBuf> = HashMap::new();
    for f in &md_files {
        if let Some(s) = stem(f) {
            by_stem.entry(s.to_lowercase()).or_insert_with(|| f.clone());
        }
    }

    let mut result: Vec<Backlink> = Vec::new();
    for source in &md_files {
        // 자기 자신은 백링크에서 제외
        if source == &target_abs {
            continue;
        }
        let body = match fs::read_to_string(source) {
            Ok(b) => b,
            Err(_) => continue, // 읽을 수 없는 파일은 건너뛴다
        };
        for (link, snippet) in extract_links(&body) {
            let resolved = match &link {
                OutLink::Standard(href) => resolve_standard_link(href, source, &root),
                OutLink::Wiki(name) => {
                    // basename 매칭: target과 같은 stem이면 바로, 아니면 인덱스로 해석
                    if let Some(ts) = &target_stem {
                        if name.eq_ignore_ascii_case(ts) {
                            Some(target_abs.clone())
                        } else {
                            by_stem.get(&name.to_lowercase()).cloned()
                        }
                    } else {
                        by_stem.get(&name.to_lowercase()).cloned()
                    }
                }
            };
            if resolved.as_deref() == Some(target_abs.as_path()) {
                result.push(Backlink {
                    source_path: source.display().to_string(),
                    source_name: source
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    snippet: snippet.clone(),
                });
                // 한 줄에 같은 대상으로의 중복 링크가 있어도 줄당 하나의 스니펫이면 충분하나,
                // 여러 줄에서 가리키면 각 줄을 보여준다. (줄 단위 중복만 정리)
            }
        }
    }
    // 같은 (소스, 스니펫) 중복 제거
    result.dedup_by(|a, b| a.source_path == b.source_path && a.snippet == b.snippet);
    result.sort_by(|a, b| a.source_path.cmp(&b.source_path));
    result.dedup_by(|a, b| a.source_path == b.source_path && a.snippet == b.snippet);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn parses_standard_links() {
        let links = links_in_line("see [목차](../00-목차.md) and [home](/README.md)");
        assert_eq!(
            links,
            vec![
                OutLink::Standard("../00-목차.md".to_string()),
                OutLink::Standard("/README.md".to_string()),
            ]
        );
    }

    #[test]
    fn parses_wiki_links_with_alias() {
        let links = links_in_line("link to [[노트A]] and [[노트B|별칭]] here");
        assert_eq!(
            links,
            vec![
                OutLink::Wiki("노트A".to_string()),
                OutLink::Wiki("노트B".to_string()),
            ]
        );
    }

    #[test]
    fn ignores_images_and_inline_code() {
        let links = links_in_line("![alt](img.png) and `[[code]]` and [real](note.md)");
        assert_eq!(links, vec![OutLink::Standard("note.md".to_string())]);
    }

    #[test]
    fn ignores_code_fences() {
        let body = "[a](a.md)\n```\n[[fenced]]\n[b](b.md)\n```\n[[c]]";
        let links: Vec<OutLink> = extract_links(body).into_iter().map(|(l, _)| l).collect();
        assert_eq!(
            links,
            vec![
                OutLink::Standard("a.md".to_string()),
                OutLink::Wiki("c".to_string()),
            ]
        );
    }

    #[test]
    fn wiki_target_strips_alias_and_anchor() {
        assert_eq!(wiki_target("name"), Some("name".to_string()));
        assert_eq!(wiki_target("name|alias"), Some("name".to_string()));
        assert_eq!(wiki_target("name#sec"), Some("name".to_string()));
        assert_eq!(wiki_target("  "), None);
    }

    #[test]
    fn resolves_relative_and_root_links() {
        let root = Path::new("/vault");
        let src = Path::new("/vault/rust/03.md");
        assert_eq!(
            resolve_standard_link("00-목차.md", src, root),
            Some(PathBuf::from("/vault/rust/00-목차.md"))
        );
        assert_eq!(
            resolve_standard_link("../README.md", src, root),
            Some(PathBuf::from("/vault/README.md"))
        );
        assert_eq!(
            resolve_standard_link("/docs/spec.md", src, root),
            Some(PathBuf::from("/vault/docs/spec.md"))
        );
        // 앵커·쿼리 제거
        assert_eq!(
            resolve_standard_link("00.md#섹션", src, root),
            Some(PathBuf::from("/vault/rust/00.md"))
        );
        // 퍼센트 인코딩 한글
        assert_eq!(
            resolve_standard_link("00-%EB%AA%A9%EC%B0%A8.md", src, root),
            Some(PathBuf::from("/vault/rust/00-목차.md"))
        );
    }

    #[test]
    fn rejects_external_and_escaping_links() {
        let root = Path::new("/vault");
        let src = Path::new("/vault/rust/03.md");
        assert_eq!(resolve_standard_link("https://x.com/a.md", src, root), None);
        assert_eq!(resolve_standard_link("mailto:a@b.c", src, root), None);
        assert_eq!(resolve_standard_link("#섹션", src, root), None);
        assert_eq!(resolve_standard_link("//cdn/a.md", src, root), None);
        assert_eq!(resolve_standard_link("../../etc/passwd", src, root), None);
    }

    #[test]
    fn builds_backlink_index_standard_and_wiki() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("target.md"), "# 대상 노트");
        write(&root.join("a.md"), "표준 링크: [대상](target.md) 입니다");
        write(
            &root.join("sub/b.md"),
            "상대 경로 [t](../target.md) 와 위키 [[target]]",
        );
        write(&root.join("c.md"), "관련 없는 노트");

        let backs = backlinks_for(root, &root.join("target.md")).unwrap();
        let names: Vec<&str> = backs.iter().map(|b| b.source_name.as_str()).collect();
        assert!(names.contains(&"a.md"));
        assert!(names.contains(&"b.md"));
        assert!(!names.contains(&"c.md"));
        // b.md는 표준+위키 두 줄이 아닌 같은 줄 위키 1개 + 표준 1개 → 두 스니펫
        let b_count = backs.iter().filter(|b| b.source_name == "b.md").count();
        assert_eq!(b_count, 1, "같은 줄의 표준+위키는 한 스니펫으로 합쳐짐");
        // 스니펫은 줄 텍스트
        let a = backs.iter().find(|b| b.source_name == "a.md").unwrap();
        assert!(a.snippet.contains("[대상](target.md)"));
    }

    #[test]
    fn wiki_resolves_by_basename_across_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("notes/대상.md"), "# 대상");
        write(&root.join("other/source.md"), "위키 [[대상]] 링크");

        let backs = backlinks_for(root, &root.join("notes/대상.md")).unwrap();
        assert_eq!(backs.len(), 1);
        assert_eq!(backs[0].source_name, "source.md");
    }

    #[test]
    fn excludes_self_and_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 자기 자신을 가리키는 링크는 제외
        write(&root.join("target.md"), "자기 참조 [self](target.md)");
        // 숨김 폴더 안의 링크는 무시
        write(&root.join(".git/x.md"), "[t](../target.md)");
        write(&root.join("real.md"), "[t](target.md)");

        let backs = backlinks_for(root, &root.join("target.md")).unwrap();
        let names: Vec<&str> = backs.iter().map(|b| b.source_name.as_str()).collect();
        assert_eq!(names, vec!["real.md"]);
    }

    #[test]
    fn nonexistent_target_yields_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("a.md"), "[x](존재.md)");
        let backs = backlinks_for(root, &root.join("없음.md")).unwrap();
        assert!(backs.is_empty());
    }

    #[test]
    fn serializes_camel_case() {
        let b = Backlink {
            source_path: "/v/a.md".to_string(),
            source_name: "a.md".to_string(),
            snippet: "x".to_string(),
        };
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"sourcePath\""));
        assert!(json.contains("\"sourceName\""));
    }
}
