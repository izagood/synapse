//! Synapse 라이브 상태 브리지 — 공유 타입과 인증 (GUI/프로토콜 비의존).
//!
//! 실행 중인 Synapse 앱은 자신이 "지금 보고 있는" 라이브 상태(현재 노트의 저장 전
//! 편집 버퍼 포함)를 loopback HTTP로 노출하고, 외부 에이전트(claude/codex 등)가
//! 띄운 Synapse MCP 사이드카가 이를 질의한다. 이 모듈은 **앱 서버**와 **MCP
//! 사이드카**가 공유하는 직렬화 타입과 인증 토큰만 담는다. MCP 프로토콜 프레이밍과
//! 디스크 검색/읽기 같은 재사용 로직은 사이드카 쪽에 둔다(core는 프로토콜 비의존).
//!
//! 보안: 서버는 `127.0.0.1`에만 바인드하고, 같은 머신의 다른 프로세스가 라이브
//! 노트 내용을 임의로 읽지 못하도록 윈도우별 무작위 토큰을 요구한다. 토큰 유출은
//! "그 윈도우에 열린 노트 전체 노출"과 같으므로 토큰은 자식 프로세스 env로만
//! 전달하고 디스크(커밋되는 `.mcp.json` 등)에 남기지 않는다.

use serde::{Deserialize, Serialize};

/// 열린 탭 한 개 (프론트 `TabInfo`의 직렬화 부분집합).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTab {
    /// 노트의 절대 경로 또는 ssh:// URI.
    pub path: String,
    /// 표시용 파일명.
    pub name: String,
    /// 파일 종류("markdown" | "html" | "pdf" | ...). 프론트 `FileType`와 동일 문자열.
    pub file_type: String,
}

/// 한 윈도우(webview)의 라이브 상태 스냅샷.
///
/// 프론트가 활성 노트/탭/내용 변경 시 디바운스로 푸시하고, 앱 서버가 윈도우 라벨로
/// 키잉해 메모리에 보관한다. MCP 사이드카는 자신이 속한 윈도우의 스냅샷만 받는다.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    /// 워크스페이스 루트(로컬 경로 또는 ssh:// URI). 시작 화면이면 `None`.
    #[serde(default)]
    pub root: Option<String>,
    /// 현재 활성 노트의 경로. 열린 노트가 없으면 `None`.
    #[serde(default)]
    pub active_path: Option<String>,
    /// 현재 활성 노트의 라이브 버퍼(저장 전 편집 포함).
    /// 활성 노트가 텍스트(마크다운 등)일 때만 채워진다.
    #[serde(default)]
    pub active_content: Option<String>,
    /// 현재 열려 있는 모든 탭.
    #[serde(default)]
    pub open_tabs: Vec<OpenTab>,
}

impl LiveState {
    /// 활성 노트가 있는지.
    pub fn has_active(&self) -> bool {
        self.active_path.is_some()
    }
}

/// 윈도우별 무작위 브리지 토큰을 생성한다.
///
/// uuid v4(각 122비트 엔트로피) 두 개를 이어 충분한 엔트로피를 확보한다. 하이픈
/// 없는 hex 문자열이라 HTTP 헤더/환경변수로 그대로 실어 보낼 수 있다.
pub fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 토큰을 상수 시간에 비교한다(타이밍 사이드채널 완화).
///
/// 길이가 다르면 즉시 false다(토큰 길이는 비밀이 아니다). 길이가 같으면 모든
/// 바이트를 XOR-누적해 조기 반환 없이 비교한다.
pub fn token_matches(expected: &str, provided: &str) -> bool {
    let a = expected.as_bytes();
    let b = provided.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_state_roundtrips_as_camel_case_json() {
        let st = LiveState {
            root: Some("/ws".to_string()),
            active_path: Some("/ws/a.md".to_string()),
            active_content: Some("# hi\n\nlive buffer".to_string()),
            open_tabs: vec![OpenTab {
                path: "/ws/a.md".to_string(),
                name: "a.md".to_string(),
                file_type: "markdown".to_string(),
            }],
        };
        let json = serde_json::to_string(&st).unwrap();
        // 프론트와 합의된 camelCase 키
        assert!(json.contains("\"activePath\""));
        assert!(json.contains("\"activeContent\""));
        assert!(json.contains("\"openTabs\""));
        assert!(json.contains("\"fileType\""));
        let back: LiveState = serde_json::from_str(&json).unwrap();
        assert_eq!(st, back);
    }

    #[test]
    fn live_state_defaults_when_fields_missing() {
        // 프론트가 시작 화면(루트 없음)을 보낼 때 빈 객체도 허용한다.
        let st: LiveState = serde_json::from_str("{}").unwrap();
        assert_eq!(st, LiveState::default());
        assert!(!st.has_active());
    }

    #[test]
    fn generated_tokens_are_long_and_distinct() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        // uuid simple = 32 hex chars; 둘을 이어 64자
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_matches_only_on_exact_equality() {
        let t = generate_token();
        assert!(token_matches(&t, &t.clone()));
        assert!(!token_matches(&t, "short"));
        assert!(!token_matches(&t, ""));
        let mut wrong = t.clone();
        // 마지막 글자만 바꿔도 불일치
        wrong.pop();
        wrong.push(if t.ends_with('0') { '1' } else { '0' });
        assert!(!token_matches(&t, &wrong));
    }
}
