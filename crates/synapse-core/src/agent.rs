//! claude CLI 헤드리스 모드(stream-json) 연동 — GUI 비의존 (PLAN-v0.4).
//!
//! `claude -p --output-format stream-json --verbose`는 NDJSON을 한 줄에 한
//! 이벤트씩 내보낸다. 스키마가 완전히 문서화되어 있지 않고 버전에 따라 새
//! 타입이 섞여 오므로(예: rate_limit_event), 모르는 타입·깨진 줄은 조용히
//! 무시한다. 파서가 깨지더라도 UI는 계속 동작해야 한다.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 프론트엔드(src/ipc/types.ts AgentEvent)와 1:1 대응하는 표시용 이벤트.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// system/init — 세션 시작. session_id는 다음 턴 `--resume`에 쓴다.
    Started { session_id: String, model: String },
    /// assistant 메시지의 text 블록
    Text { text: String },
    /// assistant 메시지의 tool_use 블록 (detail은 input에서 뽑은 표시용 요약)
    ToolUse { name: String, detail: String },
    /// result — 턴 종료. ok=false면 CLI가 오류로 끝났다.
    Completed {
        ok: bool,
        result: String,
        session_id: String,
        cost_usd: f64,
        num_turns: u64,
    },
    /// 프로세스 실패 시 셸(src-tauri)에서 합성 — 파서는 만들지 않는다
    Failed { message: String },
    /// 사용자가 중단했을 때 셸에서 합성
    Aborted,
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// tool_use input에서 사람이 알아볼 만한 대표 값을 하나 고른다.
fn tool_detail(input: Option<&Value>) -> String {
    const KEYS: [&str; 7] = ["file_path", "path", "pattern", "command", "url", "query", "description"];
    let Some(obj) = input.and_then(Value::as_object) else {
        return String::new();
    };
    for key in KEYS {
        if let Some(s) = obj.get(key).and_then(Value::as_str) {
            let mut s = s.trim().to_owned();
            if s.chars().count() > 80 {
                s = s.chars().take(79).collect::<String>() + "…";
            }
            return s;
        }
    }
    String::new()
}

/// stream-json 한 줄을 표시용 이벤트로 변환한다.
/// assistant 메시지 하나가 text·tool_use 블록 여러 개를 담을 수 있어 Vec을 돌려준다.
pub fn parse_stream_line(line: &str) -> Vec<AgentEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return Vec::new();
    };
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            vec![AgentEvent::Started {
                session_id: str_field(&v, "session_id"),
                model: str_field(&v, "model"),
            }]
        }
        Some("assistant") => {
            let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
                return Vec::new();
            };
            let mut events = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = str_field(block, "text");
                        if !text.is_empty() {
                            events.push(AgentEvent::Text { text });
                        }
                    }
                    Some("tool_use") => events.push(AgentEvent::ToolUse {
                        name: str_field(block, "name"),
                        detail: tool_detail(block.get("input")),
                    }),
                    _ => {}
                }
            }
            events
        }
        Some("result") => {
            let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let result = match v.get("result").and_then(Value::as_str) {
                Some(s) => s.to_owned(),
                None if is_error => "에이전트가 오류로 종료되었습니다".to_owned(),
                None => String::new(),
            };
            vec![AgentEvent::Completed {
                ok: !is_error,
                result,
                session_id: str_field(&v, "session_id"),
                cost_usd: v.get("total_cost_usd").and_then(Value::as_f64).unwrap_or(0.0),
                num_turns: v.get("num_turns").and_then(Value::as_u64).unwrap_or(0),
            }]
        }
        _ => Vec::new(),
    }
}

/// PATH와 잘 알려진 설치 경로에서 claude 실행 파일을 찾는다.
/// macOS GUI 앱은 로그인 셸 PATH를 물려받지 않으므로(Finder 실행)
/// 표준 설치 위치 fallback이 필수다.
pub fn find_claude_binary(path_var: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &["claude"]
    };
    let separator = if cfg!(windows) { ';' } else { ':' };

    let mut dirs: Vec<PathBuf> = path_var
        .unwrap_or("")
        .split(separator)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin")); // 네이티브 설치 기본 위치
        dirs.push(home.join(".claude").join("local")); // claude migrate-installer
        dirs.push(home.join("bin"));
        if cfg!(windows) {
            dirs.push(home.join("AppData").join("Roaming").join("npm"));
            dirs.push(home.join("AppData").join("Local").join("Programs").join("claude"));
        }
    }
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(localappdata).join("Programs").join("claude"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }

    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // claude 2.1.172 실측 출력에서 발췌한 라인들
    const INIT_LINE: &str = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"a8f95ec2-1fe4-4c6c-aa47-9bffd67d5f9f","tools":["Read"],"model":"claude-fable-5[1m]","permissionMode":"auto","claude_code_version":"2.1.172","uuid":"x"}"#;
    const ASSISTANT_TEXT_LINE: &str = r#"{"type":"assistant","message":{"model":"claude-fable-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"PONG"}],"usage":{"output_tokens":1}},"session_id":"s1","uuid":"y"}"#;
    const RESULT_LINE: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":8794,"num_turns":1,"result":"PONG","stop_reason":"end_turn","session_id":"s1","total_cost_usd":0.107175,"uuid":"z"}"#;

    #[test]
    fn parses_system_init_as_started() {
        let events = parse_stream_line(INIT_LINE);
        assert_eq!(
            events,
            vec![AgentEvent::Started {
                session_id: "a8f95ec2-1fe4-4c6c-aa47-9bffd67d5f9f".into(),
                model: "claude-fable-5[1m]".into(),
            }]
        );
    }

    #[test]
    fn parses_assistant_text_blocks() {
        let events = parse_stream_line(ASSISTANT_TEXT_LINE);
        assert_eq!(events, vec![AgentEvent::Text { text: "PONG".into() }]);
    }

    #[test]
    fn parses_assistant_tool_use_with_detail() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"읽어볼게요"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/notes/README.md"}}]},"session_id":"s1"}"#;
        let events = parse_stream_line(line);
        assert_eq!(
            events,
            vec![
                AgentEvent::Text { text: "읽어볼게요".into() },
                AgentEvent::ToolUse { name: "Read".into(), detail: "/notes/README.md".into() },
            ]
        );
    }

    #[test]
    fn parses_result_success() {
        let events = parse_stream_line(RESULT_LINE);
        assert_eq!(
            events,
            vec![AgentEvent::Completed {
                ok: true,
                result: "PONG".into(),
                session_id: "s1".into(),
                cost_usd: 0.107175,
                num_turns: 1,
            }]
        );
    }

    #[test]
    fn parses_result_error_without_result_text() {
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":3,"session_id":"s2"}"#;
        let events = parse_stream_line(line);
        match &events[..] {
            [AgentEvent::Completed { ok: false, result, session_id, .. }] => {
                assert!(!result.is_empty());
                assert_eq!(session_id, "s2");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn ignores_unknown_event_types_and_garbage() {
        // 문서화되지 않은 타입(rate_limit_event 등)과 깨진 줄은 무시한다
        let rate_limit = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"uuid":"u"}"#;
        assert!(parse_stream_line(rate_limit).is_empty());
        assert!(parse_stream_line("not json at all").is_empty());
        assert!(parse_stream_line("").is_empty());
        // 도구 결과(user 메시지)는 Phase 1에서 표시하지 않는다
        let user = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"..."}]}}"#;
        assert!(parse_stream_line(user).is_empty());
    }

    #[test]
    fn tool_detail_truncates_long_values() {
        let long = "x".repeat(200);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
        );
        match &parse_stream_line(&line)[..] {
            [AgentEvent::ToolUse { detail, .. }] => assert!(detail.chars().count() <= 80),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn serializes_camel_case_tagged_for_frontend() {
        let json = serde_json::to_value(AgentEvent::Started {
            session_id: "s".into(),
            model: "m".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "started");
        assert_eq!(json["sessionId"], "s");
        let done = serde_json::to_value(AgentEvent::Completed {
            ok: true,
            result: "r".into(),
            session_id: "s".into(),
            cost_usd: 0.1,
            num_turns: 2,
        })
        .unwrap();
        assert_eq!(done["kind"], "completed");
        assert_eq!(done["costUsd"], 0.1);
        assert_eq!(done["numTurns"], 2);
        assert_eq!(
            serde_json::to_value(AgentEvent::Aborted).unwrap()["kind"],
            "aborted"
        );
    }

    #[test]
    fn finds_binary_in_path_and_fallback_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let path_dir = tmp.path().join("on-path");
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&path_dir).unwrap();
        std::fs::create_dir_all(home.join(".local").join("bin")).unwrap();

        let name = if cfg!(windows) { "claude.exe" } else { "claude" };

        // 아무 데도 없으면 None
        assert_eq!(
            find_claude_binary(Some(path_dir.to_str().unwrap()), Some(&home)),
            None
        );

        // PATH에 있으면 그걸 먼저 찾는다
        std::fs::write(path_dir.join(name), b"#!/bin/sh\n").unwrap();
        assert_eq!(
            find_claude_binary(Some(path_dir.to_str().unwrap()), Some(&home)),
            Some(path_dir.join(name))
        );

        // PATH에 없어도 ~/.local/bin fallback에서 찾는다 (GUI 앱 환경)
        let fallback = home.join(".local").join("bin").join(name);
        std::fs::write(&fallback, b"#!/bin/sh\n").unwrap();
        assert_eq!(find_claude_binary(Some(""), Some(&home)), Some(fallback));
    }

    #[cfg(windows)]
    #[test]
    fn finds_windows_npm_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let npm = home.join("AppData").join("Roaming").join("npm");
        std::fs::create_dir_all(&npm).unwrap();
        let fallback = npm.join("claude.cmd");
        std::fs::write(&fallback, b"@echo off\r\n").unwrap();
        assert_eq!(find_claude_binary(Some(""), Some(&home)), Some(fallback));
    }
}
