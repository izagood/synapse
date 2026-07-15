//! 노트 그래프 자동 연결 (auto-links): 마커 블록 재작성 + 후보 스코어링.
//!
//! 외부 agent가 MCP 도구로 후보(`link_candidates`)를 받아 판단하고,
//! 확정한 연결을 `apply_links`로 적용하면 이 모듈이 노트 하단의 관리
//! 마커 블록만 멱등하게 재작성한다. 마커 밖 바이트는 절대 바꾸지 않는다.
//! 설계: docs/auto-links-design.md

/// auto-links 관리 블록 시작/종료 마커. 블록은 기계 소유이며 내용은 항상
/// `apply_links` 입력으로 전량 결정된다(멱등성의 근원).
pub const AUTO_LINKS_START: &str = "<!-- synapse:auto-links:start -->";
pub const AUTO_LINKS_END: &str = "<!-- synapse:auto-links:end -->";

/// 마커 블록 재작성 결과.
#[derive(Debug)]
pub struct RewriteOutcome {
    /// 재작성된 전체 내용. 마커 블록 밖 바이트는 원문 그대로다.
    pub content: String,
    /// 이상 상황 경고(중복 블록, 종료 마커 누락 등). 실패는 아니다.
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
}
