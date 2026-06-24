//! 내장 터미널 + MCP 자동 주입을 위한 순수 로직 (GUI/PTY 비의존).
//!
//! 내장 터미널에서 사용자가 `claude`/`codex`를 실행하면, 그 에이전트가 Synapse MCP
//! 사이드카를 자동으로 인식해 "지금 보고 있는 노트"를 받아 쓰도록 한다. 이를 위해:
//! - 터미널 자식 프로세스 env에 브리지 접속 정보(포트/토큰)를 주입한다. 토큰이 곧
//!   윈도우 선택자라 별도 윈도우 식별자는 보내지 않는다. **비밀(토큰)은 env로만
//!   전달**하고 디스크 설정 파일에는 절대 쓰지 않는다(유출 표면 최소화).
//! - claude는 `.mcp.json`, codex는 `config.toml`로 사이드카 실행 명령을 선언한다.
//!   여기엔 비밀을 넣지 않는다 — 사이드카는 부모(터미널) env에서 포트/토큰을 상속한다.
//!
//! 이 모듈은 문자열/맵을 만드는 순수 함수만 담는다. 실제 PTY 스폰·파일 쓰기는
//! `src-tauri`의 얇은 바인딩이 담당한다.

/// 터미널 자식 프로세스에 주입할 브리지 환경변수.
///
/// 셸 → claude/codex → synapse-mcp 사이드카로 env가 상속되어, 사이드카가 같은
/// 윈도우의 브리지에 접속한다.
pub fn bridge_env(port: u16, token: &str) -> Vec<(String, String)> {
    vec![
        ("SYNAPSE_BRIDGE_PORT".to_string(), port.to_string()),
        ("SYNAPSE_BRIDGE_TOKEN".to_string(), token.to_string()),
    ]
}

/// claude가 읽는 `.mcp.json` 내용을 만든다.
///
/// 사이드카 실행 명령만 선언하고 **비밀은 넣지 않는다**(포트/토큰은 부모 env 상속).
/// 그래서 이 파일은 워크스페이스에 커밋돼도 안전하다.
pub fn mcp_config_json(sidecar_path: &str) -> String {
    let value = serde_json::json!({
        "mcpServers": {
            "synapse": {
                "command": sidecar_path,
                "args": []
            }
        }
    });
    // 사람이 열어볼 수 있게 보기 좋은 들여쓰기로 직렬화.
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

/// codex `~/.codex/config.toml`에 넣을 `[mcp_servers.synapse]` 스니펫을 만든다.
///
/// 멱등 등록을 위해 호출 측이 기존 같은 블록을 교체할 수 있도록, 헤더는
/// 정확히 `[mcp_servers.synapse]`로 고정한다. 비밀은 넣지 않는다.
pub fn codex_config_snippet(sidecar_path: &str) -> String {
    // TOML 문자열 값은 큰따옴표 안에서 역슬래시/따옴표를 이스케이프해야 한다
    // (Windows 경로의 `\` 대응).
    let escaped = sidecar_path.replace('\\', "\\\\").replace('"', "\\\"");
    format!("[mcp_servers.synapse]\ncommand = \"{escaped}\"\nargs = []\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_env_carries_port_and_token() {
        let env = bridge_env(54321, "tok-abc");
        assert!(env.contains(&("SYNAPSE_BRIDGE_PORT".to_string(), "54321".to_string())));
        assert!(env.contains(&("SYNAPSE_BRIDGE_TOKEN".to_string(), "tok-abc".to_string())));
    }

    #[test]
    fn mcp_config_declares_sidecar_without_secrets() {
        let json = mcp_config_json("/opt/synapse-mcp");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed["mcpServers"]["synapse"]["command"],
            "/opt/synapse-mcp"
        );
        // 비밀이 파일에 새지 않아야 한다.
        assert!(!json.contains("TOKEN"));
        assert!(!json.contains("token"));
    }

    #[test]
    fn codex_snippet_has_fixed_header_and_escapes_backslashes() {
        let snippet = codex_config_snippet(r"C:\tools\synapse-mcp.exe");
        assert!(snippet.starts_with("[mcp_servers.synapse]\n"));
        assert!(snippet.contains(r#"command = "C:\\tools\\synapse-mcp.exe""#));
        assert!(!snippet.contains("TOKEN"));
    }
}
