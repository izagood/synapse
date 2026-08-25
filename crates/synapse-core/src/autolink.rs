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
    collect_markdown, extract_links, resolve_standard_link, stem, stem_index, toggle_fence, OutLink,
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
    pub all: Vec<(usize, usize)>,
    pub duplicate: bool,
    pub unterminated: bool,
}

/// 코드펜스를 무시하며 모든 auto-links 블록을 찾는다. `lines`는
/// `split_inclusive('\n')` 결과(개행 보존) 기준.
/// H2: CommonMark 호환 펜스 파싱 적용 (links::toggle_fence 재사용).
pub(crate) fn scan_auto_block(lines: &[&str]) -> BlockScan {
    let mut in_fence = false;
    let mut current_fence: Option<(char, usize)> = None;
    let mut first: Option<(usize, usize)> = None;
    let mut all: Vec<(usize, usize)> = Vec::new();
    let mut duplicate = false;
    let mut unterminated = false;
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        let (new_in_fence, new_fence) = toggle_fence(t, in_fence, current_fence);
        if new_in_fence != in_fence {
            in_fence = new_in_fence;
            current_fence = new_fence;
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
            }
            // 종료 마커 탐색(블록 안에도 펜스가 있을 수 있어 계속 토글)
            let mut j = i + 1;
            let mut fence = false;
            let mut fence_state: Option<(char, usize)> = None;
            let mut end = None;
            while j < lines.len() {
                let tj = lines[j].trim();
                let (new_fence, new_fence_state) = toggle_fence(tj, fence, fence_state);
                if new_fence != fence {
                    fence = new_fence;
                    fence_state = new_fence_state;
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
                    if first.is_none() {
                        first = Some((i, e));
                    }
                    all.push((i, e));
                    i = e + 1;
                    continue;
                }
                None => {
                    // 종료 마커가 없으면(잘림/훼손) 블록은 기계 소유이므로 EOF까지로 간주.
                    if first.is_none() {
                        first = Some((i, lines.len().saturating_sub(1)));
                    }
                    if !duplicate {
                        all.push((i, lines.len().saturating_sub(1)));
                    }
                    unterminated = true;
                    break;
                }
            }
        }
        i += 1;
    }
    BlockScan {
        first,
        all,
        duplicate,
        unterminated,
    }
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
/// 모든 auto-links 블록을 "안쪽"으로 취급한다(L9-1: 두 번째 블록의 링크가 후보를 잘못 억제하던 버그 수정).
fn split_auto_block(content: &str) -> (String, String) {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let scan = scan_auto_block(&lines);
    if scan.all.is_empty() {
        return (content.to_string(), String::new());
    }
    let mut outside = String::new();
    let mut inside = String::new();
    let mut last_end = 0;
    for (s, e) in &scan.all {
        for l in lines[last_end..*s].iter() {
            outside.push_str(l);
        }
        for l in lines[*s..=*e].iter() {
            inside.push_str(l);
        }
        last_end = e + 1;
    }
    for l in lines[last_end..].iter() {
        outside.push_str(l);
    }
    (outside, inside)
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
        let Ok(body) = std::fs::read_to_string(f) else {
            continue;
        };
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
/// L9-2: EOL 파라미터로 문서와 동일한 줄 endings 사용.
fn render_block(items: &[String], eol: &str) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut s = String::new();
    s.push_str(AUTO_LINKS_START);
    s.push_str(eol);
    s.push_str("## 관련 노트");
    s.push_str(eol);
    for it in items {
        s.push_str(it);
        s.push_str(eol);
    }
    s.push_str(AUTO_LINKS_END);
    s.push_str(eol);
    s
}

/// H1: 라벨을 무해화(sanitize)한다.
/// - 개행 이후는 버리고 첫 줄만 사용
/// - `-->`·`<!--` 제거
/// - 3개 이상 연속 백틱(` ``` `) 제거
/// - `~~~` 시퀀스 제거
fn sanitize_label(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    let mut in_backticks = 0;
    let mut tilde_count = 0;

    while let Some(c) = chars.next() {
        if c == '\n' {
            break;
        }

        if c == '<' {
            let rest: String = chars.clone().take(3).collect();
            if rest.starts_with("!--") {
                for _ in 0..3 {
                    chars.next();
                }
                continue;
            }
        }

        if c == '-' && chars.clone().take(2).collect::<String>() == "--" {
            chars.next();
            chars.next();
            continue;
        }

        if c == '`' {
            in_backticks += 1;
            if in_backticks >= 3 {
                continue;
            }
        } else {
            in_backticks = 0;
        }

        if c == '~' {
            tilde_count += 1;
            if tilde_count >= 3 {
                continue;
            }
        } else {
            tilde_count = 0;
        }

        out.push(c);
    }

    out.trim().to_string()
}

/// H1·M13: 이 stem을 [[위키링크]]로 방출해도 안전한가.
/// links.rs의 wiki_target은 `|`(별칭)·`#`(앵커) 앞에서 자르고, `[`/`]`는
/// 스캔을 깨며, 백틱·개행은 인라인 규칙과 충돌한다 — 하나라도 있으면
/// 방출과 파싱이 비대칭이 되어 오연결/dangling이 생기므로 표준 링크로 폴백한다.
fn is_wiki_safe_stem(stem: &str) -> bool {
    !stem.is_empty()
        && !stem
            .chars()
            .any(|c| matches!(c, '|' | '#' | '[' | ']' | '`' | '\n' | '\r'))
}

/// rel 경로를 최소한으로 percent-encode한다. synapse 자신의 링크 파서(`links.rs`)가
/// 오해석할 수 있는 문자(`%`, `(`, `)`, `#`, `?`, 공백)만 인코딩하고 `/`는 경로
/// 구분자이므로 그대로 둔다. `resolve_standard_link`의 percent-decode와 정확히
/// 왕복된다.
fn percent_encode_path(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len());
    for c in rel.chars() {
        match c {
            '%' | '(' | ')' | '#' | '?' | ' ' => out.push_str(&format!("%{:02X}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

/// 문서의 지배적 EOL을 감지한다. CRLF가 하나라도 있으면 CRLF, 아니면 LF.
fn dominant_eol(content: &str) -> &str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// auto-links 마커 블록만 `items`로 통째 재작성한다(멱등). 블록이 없고
/// `items`가 있으면 파일 끝에 빈 줄 하나를 두고 추가한다. 마커 밖 바이트는
/// 절대 바꾸지 않는다.
/// L9-2: 문서의 지배적 EOL을 유지한다(CRLF 문서에 CRLF 블록 삽입).
///
/// **H3 정책**: 종료 마커가 없는 블록은 재작성하지 않고 원본을 그대로 반환한다.
/// 사용자의 본문이 의도치 않게 삭제되는 것을 방지한다.
pub fn rewrite_auto_links(original: &str, items: &[String]) -> RewriteOutcome {
    let lines: Vec<&str> = original.split_inclusive('\n').collect();
    let scan = scan_auto_block(&lines);
    let mut warnings = Vec::new();
    if scan.duplicate {
        warnings.push("auto-links 블록이 여러 개 있어 첫 블록만 갱신했습니다".to_string());
    }
    if scan.unterminated {
        return RewriteOutcome {
            content: original.to_string(),
            warnings: vec!["auto-links 종료 마커가 없어 재작성을 거부했습니다".to_string()],
        };
    }
    let eol = dominant_eol(original);
    let block = render_block(items, eol);
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
                out.push_str(eol);
            }
            // 이미 빈 줄(연속 개행)로 끝나면 구분 빈 줄을 또 넣지 않는다 —
            // add→remove→add를 반복해도 빈 줄이 누적되지 않게 한다.
            let double_eol = format!("{eol}{eol}");
            if !original.trim_end().is_empty() && !original.ends_with(&double_eol) {
                out.push_str(eol); // 본문과 블록 사이 빈 줄 하나
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

        // 위키링크는 (1) stem이 파서와 왕복 가능한 안전 문자로만 이뤄지고(M13·H1)
        // (2) 이 대상으로 정확히 해석될 때(stem 충돌 없음)만 방출한다.
        // 아니면 루트 기준 표준 링크로 폴백해 오연결을 막는다.
        let use_wiki =
            is_wiki_safe_stem(&name) && by_stem.get(&name.to_lowercase()) == Some(&target);

        let href = if use_wiki {
            format!("[[{name}]]")
        } else {
            let rel = target
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let rel = percent_encode_path(&rel);
            let safe_name = name.replace('[', "(").replace(']', ")");
            format!("[{safe_name}](/{rel})")
        };
        match &link.label {
            Some(l) if !l.trim().is_empty() => {
                // H1: 라벨 무해화
                let sanitized = sanitize_label(l);
                if sanitized.is_empty() {
                    items.push(format!("- {href}"));
                } else {
                    items.push(format!("- {href} — {}", sanitized));
                }
            }
            _ => items.push(format!("- {href}")),
        }
    }

    // 전량 거부 방어: links가 비어 있지 않은데(전달은 됐는데) 검증 통과분이
    // 0이면 기존 블록을 지우지 않는다 — 링크 전량이 존재하지 않는 파일을
    // 가리키는 등 이상 입력 때문에 사용자의 기존 auto-links 블록이 통째로
    // 사라지는 것을 막는다. links가 진짜 빈 slice(명시적 비움)면 기존대로
    // 블록을 제거한다.
    let content = if !links.is_empty() && items.is_empty() {
        warnings.push("유효한 링크가 없어 기존 블록을 유지했습니다".to_string());
        base.to_string()
    } else {
        let rewrite = rewrite_auto_links(base, &items);
        warnings.extend(rewrite.warnings);
        rewrite.content
    };
    Ok(ApplyOutcome {
        content,
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
        assert!(removed
            .content
            .starts_with("---\r\ntitle: x\r\n---\r\n본문 끝"));
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
    fn add_remove_add_cycle_does_not_accumulate_blank_lines() {
        // add → remove(빈 목록) → add 를 반복해도 구분 빈 줄이 누적되지 않아야 한다.
        let step1 = rewrite_auto_links("본문\n", &["- [[b]]".to_string()]);
        let step2 = rewrite_auto_links(&step1.content, &[]); // remove
        let step3 = rewrite_auto_links(&step2.content, &["- [[b]]".to_string()]); // add again
        assert_eq!(
            step3.content, step1.content,
            "2회차 add 결과가 1회차와 같아야 함(빈 줄 누적 없음)"
        );

        // 한 사이클 더 반복해도 여전히 동일해야 한다.
        let step4 = rewrite_auto_links(&step3.content, &[]);
        let step5 = rewrite_auto_links(&step4.content, &["- [[b]]".to_string()]);
        assert_eq!(step5.content, step1.content, "3회차도 동일해야 함");
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
            s = AUTO_LINKS_START,
            e = AUTO_LINKS_END
        );
        let out = rewrite_auto_links(&body, &["- [[new]]".to_string()]);
        assert!(out.content.contains("- [[new]]"));
        assert!(
            out.content.contains("- [[dup]]"),
            "두 번째 블록은 손대지 않음"
        );
        assert!(!out.content.contains("- [[old]]"));
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn unterminated_block_rejected_and_preserves_content() {
        // H3 정책: 종료 마커가 없으면 재작성 거부, 원본 전체 보존
        let body = format!("본문\n{}\n- [[old]]\n깨진 꼬리", AUTO_LINKS_START);
        let out = rewrite_auto_links(&body, &["- [[new]]".to_string()]);
        assert_eq!(out.content, body, "원본이 그대로 보존되어야 함");
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("재작성을 거부했습니다")),
            "재작성 거부 경고가 있어야 함"
        );
    }

    #[test]
    fn malicious_label_cannot_break_block_scan() {
        // H1: 라벨에 개행+펜스를 주입해도 독립 라인으로 승격되지 않아야 한다.
        // 승격되면 다음 apply의 스캔이 종료 마커를 펜스 안으로 오인해
        // 블록 아래 사용자 본문이 삭제된다(감사에서 확인된 손실 경로).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("target.md"), "t");
        let body = format!(
            "본문\n\n{}\n{}\n\n블록 아래 사용자 본문\n",
            AUTO_LINKS_START, AUTO_LINKS_END
        );
        write(&root.join("from.md"), &body);
        let links = vec![ApplyLink {
            to: root.join("target.md").display().to_string(),
            label: Some("설명\n```".to_string()),
        }];
        let out = apply_auto_links(root, &root.join("from.md"), &body, &links).unwrap();
        assert!(
            !out.content.lines().any(|l| l.trim() == "```"),
            "주입된 펜스가 독립 라인이 되면 안 됨:\n{}",
            out.content
        );
        assert!(out.content.contains("블록 아래 사용자 본문"));
        // 재적용(스캔→재작성 왕복)해도 블록 아래 본문이 보존된다
        let out2 = apply_auto_links(root, &root.join("from.md"), &out.content, &links).unwrap();
        assert!(out2.content.contains("블록 아래 사용자 본문"));
    }

    #[test]
    fn four_backtick_fence_hides_documented_markers() {
        // H2: 4-백틱 펜스 안의 ```와 마커 문서화가 진짜 블록으로 오인되면
        // 미종결 판정 → (구정책에선) 펜스 내용과 아래 본문까지 삭제됐다.
        let body = format!("````\n```\n{}\n```\n````\n\n진짜 본문\n", AUTO_LINKS_START);
        let lines: Vec<&str> = body.split_inclusive('\n').collect();
        let scan = scan_auto_block(&lines);
        assert!(scan.first.is_none(), "펜스 안 마커가 블록으로 잡히면 안 됨");
        assert!(!scan.unterminated);
    }

    #[test]
    fn l9_all_auto_blocks_count_as_inside() {
        // 중복 블록이 있으면 두 번째 블록의 링크가 "사람이 쓴 링크"로 계산돼
        // 후보를 잘못 억제했다(L9-1). 모든 블록이 안쪽으로 잡혀야 한다.
        let body = format!(
            "본문\n\n{}\n- [[a]]\n{}\n\n가운데 사람 글\n\n{}\n- [[b]]\n{}\n\n끝\n",
            AUTO_LINKS_START, AUTO_LINKS_END, AUTO_LINKS_START, AUTO_LINKS_END
        );
        let (outside, inside) = split_auto_block(&body);
        assert!(
            inside.contains("[[a]]") && inside.contains("[[b]]"),
            "inside={inside}"
        );
        assert!(
            !outside.contains("[[a]]") && !outside.contains("[[b]]"),
            "outside={outside}"
        );
        assert!(outside.contains("가운데 사람 글") && outside.contains("끝"));
    }

    #[test]
    fn l9_block_follows_document_eol() {
        // CRLF 문서에 LF 블록을 넣으면 EOL이 섞인다(L9-2).
        let body = "본문\r\n\r\n둘째 줄\r\n";
        let out = rewrite_auto_links(body, &["- [[x]]".to_string()]);
        let added = &out.content[body.len()..];
        assert!(added.contains("\r\n"), "CRLF 문서엔 CRLF로 삽입: {added:?}");
        assert!(
            !added.replace("\r\n", "").contains('\n'),
            "LF 단독 개행이 섞이면 안 된다: {added:?}"
        );
    }

    #[test]
    fn l9_links_survive_odd_backticks_in_line() {
        // 홀수 백틱 줄에서 링크를 통째로 버리면 인덱싱이 누락된다(L9-3).
        // 짝이 맞는 코드 스팬 안은 여전히 무시해야 한다.
        let found = crate::links::extract_links("가격은 `100 원 그리고 [[노트]] 참고\n");
        assert!(
            found
                .iter()
                .any(|(l, _)| matches!(l, crate::links::OutLink::Wiki(t) if t == "노트")),
            "홀수 백틱 줄의 링크는 살아야 한다: {found:?}"
        );
        let in_code = crate::links::extract_links("`[[코드안]]` 설명\n");
        assert!(
            !in_code
                .iter()
                .any(|(l, _)| matches!(l, crate::links::OutLink::Wiki(t) if t == "코드안")),
            "짝이 맞는 코드 스팬 안은 무시: {in_code:?}"
        );
    }

    #[test]
    fn special_char_stem_falls_back_to_standard_link() {
        // M13: `C# 정리.md`를 [[C# 정리]]로 방출하면 links.rs의 wiki_target이
        // '#' 앞에서 잘라 "C"로 오연결된다 — 표준 링크로 폴백해야 한다.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        write(&root.join("C# 정리.md"), "c");
        let links = vec![ApplyLink {
            to: root.join("C# 정리.md").display().to_string(),
            label: None,
        }];
        let out = apply_auto_links(root, &root.join("from.md"), "본문\n", &links).unwrap();
        assert!(
            !out.content.contains("[[C# 정리]]"),
            "위키링크로 방출되면 안 됨:\n{}",
            out.content
        );
        let found = crate::links::extract_links(&out.content);
        let href = found
            .iter()
            .find_map(|(l, _)| match l {
                crate::links::OutLink::Standard(h) => Some(h.clone()),
                _ => None,
            })
            .expect("표준 링크 폴백이 있어야 함");
        let resolved = crate::links::resolve_standard_link(
            &href,
            &root.join("from.md"),
            &root.canonicalize().unwrap(),
        )
        .expect("폴백 href가 해석 가능해야 함");
        assert_eq!(resolved, root.join("C# 정리.md").canonicalize().unwrap());
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
        assert!(
            only.iter().all(|c| c.from.ends_with("k8s.md")),
            "증분: from 제한"
        );

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
            existing_cand
                .reasons
                .iter()
                .any(|r| r.contains("기존 auto-links 항목")),
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
            ApplyLink {
                to: tmp.path().join("outside.md").display().to_string(),
                label: None,
            },
            ApplyLink {
                to: root.join("없는노트.md").display().to_string(),
                label: None,
            },
            ApplyLink {
                to: root.join("from.md").display().to_string(),
                label: None,
            },
        ];
        let out = apply_auto_links(&root, &root.join("from.md"), "본문\n", &links).unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.rejected.len(), 3);
        // 유효 링크 0개 + 기존 블록 없음 → 파일 무변경
        assert_eq!(out.content, "본문\n");
    }

    #[test]
    fn apply_all_rejected_preserves_existing_block() {
        // links가 비어 있지 않은데(3건 전달) 전부 거부되면, 기존에 있던
        // auto-links 블록을 지우지 말고 base 그대로 반환해야 한다.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        let base = format!(
            "본문\n\n{s}\n## 관련 노트\n- [[keep]]\n{e}\n",
            s = AUTO_LINKS_START,
            e = AUTO_LINKS_END
        );

        let links = vec![
            ApplyLink {
                to: root.join("없는노트.md").display().to_string(),
                label: None,
            },
            ApplyLink {
                to: root.join("from.md").display().to_string(),
                label: None,
            }, // 자기 자신
            ApplyLink {
                to: tmp.path().join("outside.md").display().to_string(),
                label: None,
            },
        ];
        let out = apply_auto_links(root, &root.join("from.md"), &base, &links).unwrap();

        assert_eq!(out.applied, 0);
        assert_eq!(out.rejected.len(), 3, "거부 사유가 채워져야 함");
        assert_eq!(
            out.content, base,
            "전량 거부 시 base 그대로(기존 블록 유지)"
        );
        assert!(
            out.content.contains("- [[keep]]"),
            "기존 블록 내용도 그대로 유지"
        );
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("유효한 링크가 없어 기존 블록을 유지")),
            "전량 거부 경고가 있어야 함: {:?}",
            out.warnings
        );
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
    fn apply_percent_encodes_fallback_href_and_roundtrips() {
        // stem 충돌 폴백 링크의 파일명에 파서를 오해석시킬 문자(괄호 등)가
        // 있으면 percent-encode해야 하고, 그 결과가 다시 links.rs 파서로
        // 정확히 원래 파일을 가리키도록 왕복돼야 한다(핵심 단언).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        // 같은 stem 충돌 준비: 정렬상 a/ 가 stem 인덱스를 차지, b/ 가 폴백 대상
        write(&root.join("a/회의록(7월).md"), "first");
        write(&root.join("b/회의록(7월).md"), "second");

        let links = vec![ApplyLink {
            to: root.join("b/회의록(7월).md").display().to_string(),
            label: None,
        }];
        let out = apply_auto_links(root, &root.join("from.md"), "본문\n", &links).unwrap();

        // 왕복 단언: extract_links + resolve_standard_link로 원래 파일을 가리키는지.
        let canonical_root = root.canonicalize().unwrap();
        let found = crate::links::extract_links(&out.content);
        let href = found
            .iter()
            .find_map(|(l, _)| match l {
                crate::links::OutLink::Standard(href) => Some(href.clone()),
                crate::links::OutLink::Wiki(_) => None,
            })
            .expect("표준 링크로 폴백된 href가 있어야 함");

        // href(괄호 안 표시 라벨이 아니라 실제 경로) 자체는 percent-encode 되어
        // 원문 괄호를 담지 않아야 한다 — 라벨 [회의록(7월)]의 괄호는 표시용이라
        // 그대로 둬도 되지만, href 안 괄호는 파서를 오해석시키므로 인코딩 필수.
        assert!(
            href.contains("%28") && href.contains("%29"),
            "href의 괄호가 percent-encode 되어야 함: {}",
            href
        );
        assert!(
            !href.contains('(') && !href.contains(')'),
            "href에 원문 괄호가 그대로 남아있으면 안 됨: {}",
            href
        );
        let resolved =
            crate::links::resolve_standard_link(&href, &root.join("from.md"), &canonical_root)
                .expect("percent-encoded href가 다시 해석 가능해야 함");
        assert_eq!(
            resolved,
            root.join("b/회의록(7월).md").canonicalize().unwrap(),
            "왕복 결과가 원래 파일 경로와 같아야 함"
        );
    }

    #[test]
    fn apply_dedups_targets_with_warning() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("from.md"), "본문\n");
        write(&root.join("b.md"), "# b");
        let links = vec![
            ApplyLink {
                to: root.join("b.md").display().to_string(),
                label: None,
            },
            ApplyLink {
                to: root.join("b.md").display().to_string(),
                label: None,
            },
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
        let links = vec![ApplyLink {
            to: root.join("b.md").display().to_string(),
            label: None,
        }];
        assert!(apply_auto_links(root, &root.join("doc.html"), "", &links).is_err());
    }
}
