//! 노트 그래프 자동 연결 (auto-links): 마커 블록 재작성 + 후보 스코어링.
//!
//! 외부 agent가 MCP 도구로 후보(`link_candidates`)를 받아 판단하고,
//! 확정한 연결을 `apply_links`로 적용하면 이 모듈이 노트 하단의 관리
//! 마커 블록만 멱등하게 재작성한다. 마커 밖 바이트는 절대 바꾸지 않는다.
//! 설계: docs/auto-links-design.md

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::links::{
    collect_markdown, extract_links, resolve_standard_link, stem, stem_index, OutLink,
};

/// auto-links 관리 블록 시작/종료 마커. 블록은 기계 소유이며 내용은 항상
/// `apply_links` 입력으로 전량 결정된다(멱등성의 근원).
pub const AUTO_LINKS_START: &str = "<!-- synapse:auto-links:start -->";
pub const AUTO_LINKS_END: &str = "<!-- synapse:auto-links:end -->";

/// agent에게 제안하는 연결 후보 한 건.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCandidate {
    /// 링크를 갖게 될 소스 노트의 절대 경로.
    pub from: String,
    /// 링크 대상 노트의 절대 경로.
    pub to: String,
    /// 휴리스틱 점수(정렬용). 클수록 유력.
    pub score: u32,
    /// 사람이 읽을 근거("제목 언급", "키워드 N개 중복", "공통 이웃 N개").
    pub reasons: Vec<String>,
    /// 이 연결이 현재 auto-links 블록에 이미 있는가. apply_links는 선언적
    /// (파일별 전량 교체)이므로, agent는 existing=true 후보의 유지 여부도
    /// 함께 판단해 최종 목록에 포함해야 한다.
    pub existing: bool,
}

/// 마커 블록 재작성 결과.
#[derive(Debug)]
pub struct RewriteOutcome {
    /// 재작성된 전체 내용. 마커 블록 밖 바이트는 원문 그대로다.
    pub content: String,
    /// 이상 상황 경고(중복 블록, 종료 마커 누락 등). 실패는 아니다.
    pub warnings: Vec<String>,
}

/// `apply_links`가 받는 링크 한 건(대상 절대 경로 + 선택 설명).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLink {
    pub to: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// 거부된 링크와 사유.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedLink {
    pub to: String,
    pub reason: String,
}

/// 한 파일에 대한 apply 결과.
#[derive(Debug)]
pub struct ApplyOutcome {
    /// 재작성된 전체 내용(거부 링크는 빠짐). base와 같을 수 있다(무변경).
    pub content: String,
    /// 블록에 들어간 링크 수.
    pub applied: usize,
    pub rejected: Vec<RejectedLink>,
    pub warnings: Vec<String>,
}

/// 첫 auto-links 블록의 위치(라인 인덱스, 마커 줄 포함).
pub(crate) struct BlockScan {
    pub first: Option<(usize, usize)>,
    pub duplicate: bool,
    pub unterminated: bool,
}

/// 코드펜스를 무시하며 첫 auto-links 블록을 찾는다. `lines`는
/// `split_inclusive('\n')` 결과(개행 보존) 기준.
pub(crate) fn scan_auto_block(lines: &[&str]) -> BlockScan {
    let mut in_fence = false;
    let mut first: Option<(usize, usize)> = None;
    let mut duplicate = false;
    let mut unterminated = false;
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            i += 1;
            continue;
        }
        if in_fence {
            i += 1;
            continue;
        }
        if t == AUTO_LINKS_START {
            if first.is_some() {
                duplicate = true;
                break;
            }
            // 종료 마커 탐색(블록 안에도 펜스가 있을 수 있어 계속 토글)
            let mut j = i + 1;
            let mut fence = false;
            let mut end = None;
            while j < lines.len() {
                let tj = lines[j].trim();
                if tj.starts_with("```") || tj.starts_with("~~~") {
                    fence = !fence;
                    j += 1;
                    continue;
                }
                if !fence && tj == AUTO_LINKS_END {
                    end = Some(j);
                    break;
                }
                j += 1;
            }
            match end {
                Some(e) => {
                    first = Some((i, e));
                    i = e + 1;
                    continue;
                }
                None => {
                    // 종료 마커가 없으면(잘림/훼손) 블록은 기계 소유이므로 EOF까지로 간주.
                    first = Some((i, lines.len().saturating_sub(1)));
                    unterminated = true;
                    break;
                }
            }
        }
        i += 1;
    }
    BlockScan { first, duplicate, unterminated }
}

/// 한 노트의 사전 계산 상태.
struct NoteInfo {
    body_lower: String,
    /// 본문(auto 블록 제외)의 링크가 가리키는 노트 집합 — "사람 링크".
    human_targets: HashSet<PathBuf>,
    /// auto 블록 안 링크가 가리키는 노트 집합.
    auto_targets: HashSet<PathBuf>,
    /// 빈도 상위 키워드.
    keywords: HashSet<String>,
}

/// 본문에서 빈도 상위 키워드를 뽑는다(retrieval과 같은 토큰화 규칙).
fn top_keywords(body_lower: &str, k: usize) -> HashSet<String> {
    let mut freq: HashMap<&str, u32> = HashMap::new();
    for tok in body_lower.split(|c: char| !c.is_alphanumeric()) {
        if tok.chars().count() < 2 {
            continue;
        }
        if crate::retrieval::STOPWORDS.contains(&tok) {
            continue;
        }
        *freq.entry(tok).or_insert(0) += 1;
    }
    let mut v: Vec<(&str, u32)> = freq.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    v.into_iter().take(k).map(|(t, _)| t.to_string()).collect()
}

/// 내용을 (auto 블록 밖, auto 블록 안)으로 나눈다.
fn split_auto_block(content: &str) -> (String, String) {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let scan = scan_auto_block(&lines);
    match scan.first {
        Some((s, e)) => {
            let mut outside = String::new();
            for l in lines[..s].iter().chain(lines[e + 1..].iter()) {
                outside.push_str(l);
            }
            let inside: String = lines[s..=e].concat();
            (outside, inside)
        }
        None => (content.to_string(), String::new()),
    }
}

/// 링크 목록을 대상 노트 절대 경로 집합으로 해석한다.
fn resolve_targets(
    text: &str,
    source: &Path,
    root: &Path,
    by_stem: &HashMap<String, PathBuf>,
) -> HashSet<PathBuf> {
    let mut out = HashSet::new();
    for (link, _snippet) in extract_links(text) {
        let resolved = match &link {
            OutLink::Standard(href) => resolve_standard_link(href, source, root),
            OutLink::Wiki(name) => by_stem.get(&name.to_lowercase()).cloned(),
        };
        if let Some(t) = resolved {
            if t != source {
                out.insert(t);
            }
        }
    }
    out
}

/// 워크스페이스에서 자동 연결 후보를 계산한다(결정적, LLM 없음).
///
/// `from_paths`가 비어 있지 않으면 그 노트들이 `from`인 쌍만 계산한다(증분).
/// 이미 사람 링크(auto 블록 밖)로 연결된 쌍은 제외하고, auto 블록으로만
/// 연결된 쌍은 `existing=true`로 표시해 유지한다.
pub fn link_candidates(
    root: &Path,
    from_paths: &[PathBuf],
    limit: usize,
) -> io::Result<Vec<LinkCandidate>> {
    let root = root.canonicalize()?;
    let md_files = collect_markdown(&root);
    let by_stem = stem_index(&md_files);

    // 사전 계산: 본문/링크/키워드
    let mut infos: HashMap<PathBuf, NoteInfo> = HashMap::new();
    for f in &md_files {
        let Ok(body) = std::fs::read_to_string(f) else { continue };
        let (outside, inside) = split_auto_block(&body);
        infos.insert(
            f.clone(),
            NoteInfo {
                body_lower: outside.to_lowercase(),
                human_targets: resolve_targets(&outside, f, &root, &by_stem),
                auto_targets: resolve_targets(&inside, f, &root, &by_stem),
                keywords: top_keywords(&outside.to_lowercase(), 12),
            },
        );
    }

    // 공통 이웃용 무방향 인접(사람 링크만 — auto 링크의 자기 강화 방지)
    let mut adj: HashMap<&PathBuf, HashSet<&PathBuf>> = HashMap::new();
    for (f, info) in &infos {
        for t in &info.human_targets {
            if let Some((tk, _)) = infos.get_key_value(t) {
                adj.entry(f).or_default().insert(tk);
                adj.entry(tk).or_default().insert(f);
            }
        }
    }

    // from 스코프: 지정 경로(canonicalize)만 또는 전체
    let sources: Vec<PathBuf> = if from_paths.is_empty() {
        md_files.clone()
    } else {
        from_paths
            .iter()
            .filter_map(|p| p.canonicalize().ok())
            .filter(|p| infos.contains_key(p))
            .collect()
    };

    let mut out: Vec<LinkCandidate> = Vec::new();
    for a in &sources {
        let Some(ia) = infos.get(a) else { continue };
        for b in &md_files {
            if a == b || ia.human_targets.contains(b) {
                continue;
            }
            let Some(ib) = infos.get(b) else { continue };
            let mut score = 0u32;
            let mut reasons = Vec::new();
            // 기존 auto-links 항목 여부를 먼저 판단 (score 체크 전에)
            let existing = ia.auto_targets.contains(b);

            if let Some(sb) = stem(b) {
                let sb = sb.to_lowercase();
                if sb.chars().count() >= 2 && ia.body_lower.contains(&sb) {
                    score += 30;
                    reasons.push(format!("본문이 '{sb}' 제목을 언급"));
                }
            }
            let overlap = ia.keywords.intersection(&ib.keywords).count() as u32;
            if overlap >= 2 {
                score += overlap * 8;
                reasons.push(format!("상위 키워드 {overlap}개 중복"));
            }
            let common = adj
                .get(a)
                .zip(adj.get(b))
                .map(|(na, nb)| na.intersection(nb).count() as u32)
                .unwrap_or(0);
            if common > 0 {
                score += common * 10;
                reasons.push(format!("공통 이웃 노트 {common}개"));
            }
            // 점수 0이면서 기존 항목이 아니면 스킵
            if score == 0 && !existing {
                continue;
            }
            // 기존 항목이면서 휴리스틱 점수가 0인 경우 근거 추가
            if score == 0 && existing {
                reasons.push("기존 auto-links 항목".to_string());
            }
            out.push(LinkCandidate {
                from: a.display().to_string(),
                to: b.display().to_string(),
                score,
                reasons,
                existing,
            });
        }
    }
    out.sort_by(|x, y| {
        y.score
            .cmp(&x.score)
            .then_with(|| x.from.cmp(&y.from))
            .then_with(|| x.to.cmp(&y.to))
    });
    out.truncate(limit);
    Ok(out)
}

/// 렌더된 목록 줄들로 블록 텍스트를 만든다. 빈 목록이면 빈 문자열(블록 제거).
fn render_block(items: &[String]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut s = String::new();
    s.push_str(AUTO_LINKS_START);
    s.push('\n');
    s.push_str("## 관련 노트\n");
    for it in items {
        s.push_str(it);
        s.push('\n');
    }
    s.push_str(AUTO_LINKS_END);
    s.push('\n');
    s
}

/// auto-links 마커 블록만 `items`로 통째 재작성한다(멱등). 블록이 없고
/// `items`가 있으면 파일 끝에 빈 줄 하나를 두고 추가한다. 마커 밖 바이트는
/// 절대 바꾸지 않는다.
pub fn rewrite_auto_links(original: &str, items: &[String]) -> RewriteOutcome {
    let lines: Vec<&str> = original.split_inclusive('\n').collect();
    let scan = scan_auto_block(&lines);
    let mut warnings = Vec::new();
    if scan.duplicate {
        warnings.push("auto-links 블록이 여러 개 있어 첫 블록만 갱신했습니다".to_string());
    }
    if scan.unterminated {
        warnings.push("auto-links 종료 마커가 없어 블록을 파일 끝까지로 간주했습니다".to_string());
    }
    let block = render_block(items);
    let content = match scan.first {
        Some((s, e)) => {
            let mut out = String::with_capacity(original.len() + block.len());
            for l in &lines[..s] {
                out.push_str(l);
            }
            out.push_str(&block);
            for l in &lines[e + 1..] {
                out.push_str(l);
            }
            out
        }
        None => {
            if items.is_empty() {
                return RewriteOutcome {
                    content: original.to_string(),
                    warnings,
                };
            }
            let mut out = String::with_capacity(original.len() + block.len() + 2);
            out.push_str(original);
            if !original.is_empty() && !original.ends_with('\n') {
                out.push('\n');
            }
            if !original.trim_end().is_empty() {
                out.push('\n'); // 본문과 블록 사이 빈 줄 하나
            }
            out.push_str(&block);
            out
        }
    };
    RewriteOutcome { content, warnings }
}

/// 검증·렌더 후 auto-links 블록을 재작성한다(순수 — 디스크에 쓰지 않는다).
///
/// 선언적 계약: `links`가 이 파일 블록의 전체 내용이 된다(빈 목록 = 블록 제거).
/// 각 대상은 (루트 내부, 실존, 마크다운, from 자신 아님)을 검증해 통과분만
/// 렌더하고, 나머지는 `rejected`로 돌려준다(부분 성공).
pub fn apply_auto_links(
    root: &Path,
    from: &Path,
    base: &str,
    links: &[ApplyLink],
) -> Result<ApplyOutcome, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("워크스페이스 루트를 열 수 없습니다: {e}"))?;
    let from_abs = from
        .canonicalize()
        .map_err(|e| format!("from 노트를 찾을 수 없습니다({}): {e}", from.display()))?;
    if !from_abs.starts_with(&root) {
        return Err("from 노트가 워크스페이스 밖입니다".to_string());
    }
    if !crate::links::is_markdown(&from_abs) {
        return Err("auto-links는 마크다운 노트에만 적용합니다".to_string());
    }

    let md_files = collect_markdown(&root);
    let by_stem = stem_index(&md_files);

    let mut items: Vec<String> = Vec::new();
    let mut rejected: Vec<RejectedLink> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    for link in links {
        let raw = Path::new(&link.to);
        let target = match raw.canonicalize() {
            Ok(t) => t,
            Err(_) => {
                rejected.push(RejectedLink {
                    to: link.to.clone(),
                    reason: "대상 노트가 존재하지 않습니다".to_string(),
                });
                continue;
            }
        };
        if !target.starts_with(&root) {
            rejected.push(RejectedLink {
                to: link.to.clone(),
                reason: "대상이 워크스페이스 밖입니다".to_string(),
            });
            continue;
        }
        if !crate::links::is_markdown(&target) {
            rejected.push(RejectedLink {
                to: link.to.clone(),
                reason: "대상이 마크다운 노트가 아닙니다".to_string(),
            });
            continue;
        }
        if target == from_abs {
            rejected.push(RejectedLink {
                to: link.to.clone(),
                reason: "자기 자신은 연결할 수 없습니다".to_string(),
            });
            continue;
        }
        if !seen.insert(target.clone()) {
            warnings.push(format!("중복 대상 무시: {}", link.to));
            continue;
        }
        let name = stem(&target).unwrap_or_default();
        // 위키링크가 이 대상으로 정확히 해석되면 [[stem]], 아니면(stem 충돌)
        // 루트 기준 표준 링크로 폴백해 오연결을 막는다.
        let href = if by_stem.get(&name.to_lowercase()) == Some(&target) {
            format!("[[{name}]]")
        } else {
            let rel = target
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            format!("[{name}](/{rel})")
        };
        match &link.label {
            Some(l) if !l.trim().is_empty() => items.push(format!("- {href} — {}", l.trim())),
            _ => items.push(format!("- {href}")),
        }
    }

    let rewrite = rewrite_auto_links(base, &items);
    warnings.extend(rewrite.warnings);
    Ok(ApplyOutcome {
        content: rewrite.content,
        applied: items.len(),
        rejected,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_block_when_absent() {
        let out = rewrite_auto_links("# 제목\n본문\n", &["- [[b]] — 설명".to_string()]);
        assert_eq!(
            out.content,
            "# 제목\n본문\n\n<!-- synapse:auto-links:start -->\n## 관련 노트\n- [[b]] — 설명\n<!-- synapse:auto-links:end -->\n"
        );
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn replaces_existing_block_idempotently() {
        let once = rewrite_auto_links("본문\n", &["- [[b]]".to_string()]);
        let twice = rewrite_auto_links(&once.content, &["- [[b]]".to_string()]);
        assert_eq!(once.content, twice.content, "2회 적용 = 1회 적용");
    }

    #[test]
    fn preserves_bytes_outside_block() {
        // frontmatter + CRLF + 마지막 줄 개행 없음 — 블록 밖은 바이트 그대로.
        let original = "---\r\ntitle: x\r\n---\r\n본문 끝";
        let out = rewrite_auto_links(original, &["- [[b]]".to_string()]);
        assert!(out.content.starts_with("---\r\ntitle: x\r\n---\r\n본문 끝"));
        // 다시 빈 목록으로 블록 제거하면 (append가 넣은 개행 외) 본문 원문 유지
        let removed = rewrite_auto_links(&out.content, &[]);
        assert!(removed.content.starts_with("---\r\ntitle: x\r\n---\r\n본문 끝"));
        assert!(!removed.content.contains(AUTO_LINKS_START));
    }

    #[test]
    fn empty_items_removes_block() {
        let with = rewrite_auto_links("본문\n", &["- [[b]]".to_string()]);
        let out = rewrite_auto_links(&with.content, &[]);
        assert!(!out.content.contains(AUTO_LINKS_START));
        assert!(out.content.starts_with("본문\n"));
    }

    #[test]
    fn empty_items_on_no_block_is_noop() {
        let out = rewrite_auto_links("본문\n", &[]);
        assert_eq!(out.content, "본문\n");
    }

    #[test]
    fn ignores_marker_inside_code_fence() {
        let body = format!("```\n{}\n```\n본문\n", AUTO_LINKS_START);
        let out = rewrite_auto_links(&body, &["- [[b]]".to_string()]);
        // 펜스 안 마커는 무시하고 파일 끝에 새 블록 append
        assert!(out.content.starts_with(&body));
        assert!(out.content.trim_end().ends_with(AUTO_LINKS_END));
    }

    #[test]
    fn duplicate_blocks_replace_first_and_warn() {
        let body = format!(
            "{s}\n## 관련 노트\n- [[old]]\n{e}\n중간\n{s}\n- [[dup]]\n{e}\n",
            s = AUTO_LINKS_START, e = AUTO_LINKS_END
        );
        let out = rewrite_auto_links(&body, &["- [[new]]".to_string()]);
        assert!(out.content.contains("- [[new]]"));
        assert!(out.content.contains("- [[dup]]"), "두 번째 블록은 손대지 않음");
        assert!(!out.content.contains("- [[old]]"));
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn unterminated_block_extends_to_eof_and_warns() {
        let body = format!("본문\n{}\n- [[old]]\n깨진 꼬리", AUTO_LINKS_START);
        let out = rewrite_auto_links(&body, &["- [[new]]".to_string()]);
        assert!(out.content.starts_with("본문\n"));
        assert!(out.content.contains("- [[new]]"));
        assert!(!out.content.contains("깨진 꼬리"), "종료 마커 없으면 EOF까지 블록으로 간주");
        assert_eq!(out.warnings.len(), 1);
    }

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

    #[test]
    fn candidate_title_mention_scores() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("cilium.md"), "# Cilium\nCNI 구현체");
        write(&root.join("k8s.md"), "네트워킹에서 cilium 을 쓴다");
        write(&root.join("none.md"), "무관한 노트");

        let cands = link_candidates(root, &[], 50).unwrap();
        let pair = cands
            .iter()
            .find(|c| c.from.ends_with("k8s.md") && c.to.ends_with("cilium.md"))
            .expect("제목 언급 후보가 있어야 함");
        assert!(pair.score > 0);
        assert!(!pair.existing);
        assert!(pair.reasons.iter().any(|r| r.contains("제목")));
        assert!(!cands
            .iter()
            .any(|c| c.from.ends_with("none.md") || c.to.ends_with("none.md")));
    }

    #[test]
    fn candidate_excludes_human_linked_pairs_but_flags_auto_linked() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("target.md"), "# target");
        // human: 본문에서 직접 링크 → 후보 제외
        write(&root.join("human.md"), "target 이야기. [[target]] 참고");
        // auto: 블록 안에서만 링크 → 후보 유지 + existing=true
        write(
            &root.join("auto.md"),
            &format!(
                "target 이야기\n\n{}\n## 관련 노트\n- [[target]]\n{}\n",
                AUTO_LINKS_START, AUTO_LINKS_END
            ),
        );

        let cands = link_candidates(root, &[], 50).unwrap();
        assert!(
            !cands
                .iter()
                .any(|c| c.from.ends_with("human.md") && c.to.ends_with("target.md")),
            "사람이 쓴 링크가 있는 쌍은 제외"
        );
        let auto = cands
            .iter()
            .find(|c| c.from.ends_with("auto.md") && c.to.ends_with("target.md"))
            .expect("auto 블록 링크 쌍은 후보 유지");
        assert!(auto.existing);
    }

    #[test]
    fn candidate_common_neighbor_scores() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("hub.md"), "# 허브");
        write(&root.join("a.md"), "[[hub]] 를 가리킴 alpha");
        write(&root.join("b.md"), "[[hub]] 를 가리킴 beta");

        let cands = link_candidates(root, &[], 50).unwrap();
        let ab = cands
            .iter()
            .find(|c| c.from.ends_with("a.md") && c.to.ends_with("b.md"))
            .expect("공통 이웃(hub) 후보");
        assert!(ab.reasons.iter().any(|r| r.contains("공통")));
    }

    #[test]
    fn candidate_scoped_by_from_paths_and_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("cilium.md"), "# Cilium");
        write(&root.join("k8s.md"), "cilium 언급");
        write(&root.join("other.md"), "cilium 언급");

        let only = link_candidates(root, &[root.join("k8s.md")], 50).unwrap();
        assert!(only.iter().all(|c| c.from.ends_with("k8s.md")), "증분: from 제한");

        let capped = link_candidates(root, &[], 1).unwrap();
        assert_eq!(capped.len(), 1, "limit 상한");
    }

    #[test]
    fn candidates_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("cilium.md"), "# Cilium");
        write(&root.join("k8s.md"), "cilium 언급");
        let a = link_candidates(root, &[], 50).unwrap();
        let b = link_candidates(root, &[], 50).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn candidate_serializes_camel_case() {
        let c = LinkCandidate {
            from: "/v/a.md".into(),
            to: "/v/b.md".into(),
            score: 30,
            reasons: vec!["r".into()],
            existing: false,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"from\"") && json.contains("\"existing\""));
    }

    #[test]
    fn existing_auto_links_with_zero_score_preserved() {
        // 기존 auto-links 항목이 휴리스틱 점수 0이어도 후보로 유지되는지 검증
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // target: 제목도 짧고, 키워드도 겹치지 않을 예정
        write(&root.join("target.md"), "# x");
        // from: auto-links 블록에만 target 링크가 있고,
        // 본문에는 제목 언급도, 키워드 중복도, 공통 이웃도 없는 무관한 텍스트
        write(
            &root.join("from.md"),
            &format!(
                "무관한 텍스트만 있음\n\n{}\n## 관련 노트\n- [[target]]\n{}\n",
                AUTO_LINKS_START, AUTO_LINKS_END
            ),
        );

        let cands = link_candidates(root, &[], 50).unwrap();
        let existing_cand = cands
            .iter()
            .find(|c| c.from.ends_with("from.md") && c.to.ends_with("target.md"))
            .expect("기존 auto-links 쌍이 후보에 포함되어야 함");

        assert_eq!(existing_cand.score, 0, "휴리스틱 점수가 0이어야 함");
        assert!(existing_cand.existing, "existing=true여야 함");
        assert!(
            existing_cand.reasons.iter().any(|r| r.contains("기존 auto-links 항목")),
            "reasons에 '기존 auto-links 항목' 근거가 있어야 함"
        );
    }

    #[test]
    fn apply_renders_wikilinks_with_label() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        write(&root.join("cilium.md"), "# Cilium");

        let links = vec![ApplyLink {
            to: root.join("cilium.md").display().to_string(),
            label: Some("CNI 구현체".to_string()),
        }];
        let out = apply_auto_links(root, &root.join("from.md"), "본문\n", &links).unwrap();
        assert!(out.content.contains("- [[cilium]] — CNI 구현체"));
        assert_eq!(out.applied, 1);
        assert!(out.rejected.is_empty());
        assert!(out.content.starts_with("본문\n"), "본문 불가침");
    }

    #[test]
    fn apply_rejects_outside_missing_and_self() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        fs::create_dir_all(&root).unwrap();
        write(&root.join("from.md"), "본문\n");
        write(&tmp.path().join("outside.md"), "루트 밖");

        let links = vec![
            ApplyLink { to: tmp.path().join("outside.md").display().to_string(), label: None },
            ApplyLink { to: root.join("없는노트.md").display().to_string(), label: None },
            ApplyLink { to: root.join("from.md").display().to_string(), label: None },
        ];
        let out = apply_auto_links(&root, &root.join("from.md"), "본문\n", &links).unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.rejected.len(), 3);
        // 유효 링크 0개 + 기존 블록 없음 → 파일 무변경
        assert_eq!(out.content, "본문\n");
    }

    #[test]
    fn apply_falls_back_to_root_relative_link_on_stem_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        // 같은 stem 두 개: 정렬상 a/노트.md 가 stem 인덱스를 차지
        write(&root.join("a/노트.md"), "first");
        write(&root.join("b/노트.md"), "second");

        let links = vec![ApplyLink {
            to: root.join("b/노트.md").display().to_string(),
            label: None,
        }];
        let out = apply_auto_links(root, &root.join("from.md"), "본문\n", &links).unwrap();
        assert!(
            out.content.contains("- [노트](/b/노트.md)"),
            "stem 충돌 시 루트 기준 표준 링크 폴백: {}",
            out.content
        );
    }

    #[test]
    fn apply_dedups_targets_with_warning() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        write(&root.join("b.md"), "# b");
        let links = vec![
            ApplyLink { to: root.join("b.md").display().to_string(), label: None },
            ApplyLink { to: root.join("b.md").display().to_string(), label: None },
        ];
        let out = apply_auto_links(root, &root.join("from.md"), "본문\n", &links).unwrap();
        assert_eq!(out.applied, 1);
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn apply_rejects_non_markdown_from() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("doc.html"), "<p>html</p>");
        write(&root.join("b.md"), "# b");
        let links = vec![ApplyLink { to: root.join("b.md").display().to_string(), label: None }];
        assert!(apply_auto_links(root, &root.join("doc.html"), "", &links).is_err());
    }
}
