//! `synapse_id` frontmatter 지연 제거 (Task 3: 저장 경로 단순화).
//!
//! 디스크가 단일 진실이 되면서 CRDT 문서 식별자(`synapse_id`)는 저장 경로에서
//! 더 이상 필요 없다. 이 모듈은 삭제된 옛 CRDT 저장 계층에 의존하지 않고
//! frontmatter 파싱 로직만 독립적으로 구현해, 저장 시 남아 있는 `synapse_id`
//! 줄을 지연 제거(lazy strip)한다 — 옛 CRDT 저장분을 여는 즉시 정리되는 방식.

const ID_KEY: &str = "synapse_id";

/// frontmatter 블록의 경계를 찾는다.
///
/// 반환값 `(inner_start, inner_end, block_end)`:
/// - `inner_start`: 여는 `---` 줄 다음(내용 시작) 바이트 오프셋
/// - `inner_end`: 닫는 `---` 줄이 시작하는 바이트 오프셋(내용은 `[inner_start, inner_end)`)
/// - `block_end`: 닫는 `---` 줄이 끝나는(그 줄바꿈까지 포함한) 바이트 오프셋
///
/// frontmatter는 파일 맨 앞에서만 인정한다(옛 CRDT 저장 계층의 frontmatter 탐지와 동일 규칙).
fn frontmatter_bounds(text: &str) -> Option<(usize, usize, usize)> {
    let inner_start = text
        .strip_prefix("---\r\n")
        .map(|_| 5)
        .or_else(|| text.strip_prefix("---\n").map(|_| 4))?;
    let mut pos = inner_start;
    for line in text[inner_start..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((inner_start, pos, pos + line.len()));
        }
        pos += line.len();
    }
    None
}

/// frontmatter에서 `synapse_id` 줄을 지연 제거한다.
///
/// - 제거할 줄이 없으면(=synapse_id 없음, 또는 frontmatter 자체가 없음) `None`.
/// - 다른 키가 남아 있으면 그 줄만 지우고 나머지는 바이트 그대로 보존한다.
/// - 다른 키가 없어(빈 블록) 지면 여는/닫는 `---` 블록 전체를 그 트레일링
///   줄바꿈까지 포함해 제거한다.
/// - CRLF frontmatter도 그대로 처리한다.
/// - frontmatter 밖(본문)에 있는 "synapse_id" 문자열은 절대 건드리지 않는다.
pub fn strip_doc_id(text: &str) -> Option<String> {
    let (inner_start, inner_end, block_end) = frontmatter_bounds(text)?;
    let inner = &text[inner_start..inner_end];

    let mut found = false;
    let mut remaining = String::with_capacity(inner.len());
    for line in inner.split_inclusive('\n') {
        if line.trim_start().starts_with(&format!("{ID_KEY}:")) {
            found = true;
            continue;
        }
        remaining.push_str(line);
    }
    if !found {
        return None;
    }

    if remaining.trim().is_empty() {
        // 다른 키가 없다 — 블록 전체(트레일링 줄바꿈 포함)를 제거한다.
        Some(text[block_end..].to_string())
    } else {
        let opening = &text[..inner_start];
        let closing = &text[inner_end..block_end];
        let rest = &text[block_end..];
        Some(format!("{opening}{remaining}{closing}{rest}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_synapse_id_line_and_keeps_other_keys() {
        let text = "---\ntitle: Test\nsynapse_id: abc123\n---\n\n# Body\n";
        let stripped = strip_doc_id(text).expect("synapse_id가 있으면 Some");
        assert_eq!(stripped, "---\ntitle: Test\n---\n\n# Body\n");
    }

    #[test]
    fn removes_whole_block_when_no_other_keys_remain() {
        let text = "---\nsynapse_id: abc123\n---\n\n# Body\n";
        let stripped = strip_doc_id(text).expect("synapse_id가 있으면 Some");
        assert_eq!(stripped, "\n# Body\n");
    }

    #[test]
    fn returns_none_when_no_synapse_id() {
        assert_eq!(strip_doc_id("---\ntitle: Test\n---\n\n# Body\n"), None);
        assert_eq!(strip_doc_id("# Body\nsynapse_id: 이건 본문일 뿐\n"), None);
    }

    #[test]
    fn preserves_other_frontmatter_keys_byte_exact() {
        let text = "---\na: 1\nsynapse_id: x\nb: 2\ntags:\n  - one\n  - two\n---\n\n본문\n";
        let stripped = strip_doc_id(text).unwrap();
        assert_eq!(
            stripped,
            "---\na: 1\nb: 2\ntags:\n  - one\n  - two\n---\n\n본문\n"
        );
    }

    #[test]
    fn handles_crlf_frontmatter() {
        let text = "---\r\ntitle: Test\r\nsynapse_id: abc123\r\n---\r\n\r\n# Body\r\n";
        let stripped = strip_doc_id(text).unwrap();
        assert_eq!(stripped, "---\r\ntitle: Test\r\n---\r\n\r\n# Body\r\n");
    }

    #[test]
    fn does_not_touch_synapse_id_occurrences_in_body() {
        let text = "---\nsynapse_id: abc123\n---\n\n본문에 synapse_id: fake 라는 글자가 있다\n";
        let stripped = strip_doc_id(text).unwrap();
        assert_eq!(stripped, "\n본문에 synapse_id: fake 라는 글자가 있다\n");
    }

    #[test]
    fn strips_when_synapse_id_is_first_key_with_siblings() {
        let text = "---\nsynapse_id: abc123\ntitle: Test\ntags: [a]\n---\n\n# Body\n";
        let stripped = strip_doc_id(text).unwrap();
        assert_eq!(stripped, "---\ntitle: Test\ntags: [a]\n---\n\n# Body\n");
    }

    #[test]
    fn removes_whole_block_under_crlf() {
        let text = "---\r\nsynapse_id: abc123\r\n---\r\n\r\n# Body\r\n";
        let stripped = strip_doc_id(text).unwrap();
        assert_eq!(stripped, "\r\n# Body\r\n");
    }

    #[test]
    fn empty_input_returns_none() {
        assert_eq!(strip_doc_id(""), None);
    }

    #[test]
    fn frontmatter_only_file_with_no_body() {
        // 다른 키가 없으면 파일이 통째로 비고, 있으면 블록만 남는다.
        assert_eq!(
            strip_doc_id("---\nsynapse_id: abc123\n---\n").as_deref(),
            Some("")
        );
        assert_eq!(
            strip_doc_id("---\nsynapse_id: abc123\ntitle: t\n---\n").as_deref(),
            Some("---\ntitle: t\n---\n")
        );
        // 닫는 --- 뒤에 줄바꿈이 없는 파일도 처리한다.
        assert_eq!(
            strip_doc_id("---\nsynapse_id: abc123\n---").as_deref(),
            Some("")
        );
    }
}
