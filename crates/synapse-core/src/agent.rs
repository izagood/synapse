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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    /// 도구 사용 권한 요청 (control_request/can_use_tool) — 프론트로 승인 UI를 띄운다.
    /// request_id는 stdin으로 회신할 control_response에 그대로 실어 보낸다.
    /// edit이 Some이면 파일 편집 도구(Edit/Write)라 diff 미리보기를 보여줄 수 있다.
    PermissionRequest {
        request_id: String,
        tool: String,
        /// 표시용 요약 (input에서 뽑은 대표 값)
        detail: String,
        /// 편집 도구일 때 파일 변경 미리보기 (Edit/Write). 그 외엔 None.
        edit: Option<EditPreview>,
    },
    /// 프로세스 실패 시 셸(src-tauri)에서 합성 — 파서는 만들지 않는다
    Failed { message: String },
    /// 사용자가 중단했을 때 셸에서 합성
    Aborted,
}

/// 편집 권한 요청에 딸린 파일 변경 미리보기 (Edit/Write 도구 input에서 추출).
/// 프론트엔드(src/ipc/types.ts EditPreview)와 1:1 대응.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPreview {
    /// 대상 파일 경로 (claude가 준 그대로 — 절대/상대 모두 가능)
    pub file_path: String,
    /// Edit이면 찾을 문자열, Write이면 빈 문자열
    pub old_string: String,
    /// Edit이면 바꿀 문자열, Write이면 새 파일 전체 내용
    pub new_string: String,
    /// Write(파일 전체 교체)인지 Edit(부분 치환)인지
    pub whole_file: bool,
}

/// claude CLI control 프로토콜은 비공식이라 버전에 따라 모양이 다를 수 있다.
/// 알려진 형태만 인식하고 그 외에는 None을 돌려주는 방어적 파서를 쓴다.
/// 인식하는 형태(추정):
///   {"type":"control_request","request_id":"r1",
///    "request":{"subtype":"can_use_tool","tool_name":"Edit","input":{...}}}
/// 일부 빌드는 request 없이 최상위에 tool_name/input을 두기도 해서 둘 다 본다.
pub fn parse_control_request(line: &str) -> Option<AgentEvent> {
    let v = serde_json::from_str::<Value>(line.trim()).ok()?;
    if v.get("type").and_then(Value::as_str)? != "control_request" {
        return None;
    }
    // request 객체가 있으면 그 안을, 없으면 최상위를 본다
    let body = v.get("request").unwrap_or(&v);
    // subtype이 있으면 권한 요청만 통과 (모르면 관대하게 통과시키되 도구명이 있어야 함)
    if let Some(subtype) = body.get("subtype").and_then(Value::as_str) {
        if subtype != "can_use_tool" {
            return None;
        }
    }
    let request_id = v
        .get("request_id")
        .and_then(Value::as_str)
        .or_else(|| v.get("id").and_then(Value::as_str))?
        .to_owned();
    let tool = body
        .get("tool_name")
        .or_else(|| body.get("tool"))
        .or_else(|| body.get("name"))
        .and_then(Value::as_str)?
        .to_owned();
    let input = body.get("input").or_else(|| body.get("tool_input"));
    let detail = tool_detail(input);
    let edit = extract_edit_preview(&tool, input);
    Some(AgentEvent::PermissionRequest {
        request_id,
        tool,
        detail,
        edit,
    })
}

/// Edit/Write 도구 input에서 diff 미리보기 정보를 뽑는다. 다른 도구면 None.
fn extract_edit_preview(tool: &str, input: Option<&Value>) -> Option<EditPreview> {
    let obj = input?.as_object()?;
    let file_path = obj
        .get("file_path")
        .or_else(|| obj.get("path"))
        .and_then(Value::as_str)?
        .to_owned();
    match tool {
        "Write" => Some(EditPreview {
            file_path,
            old_string: String::new(),
            new_string: obj
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            whole_file: true,
        }),
        "Edit" => Some(EditPreview {
            file_path,
            old_string: str_field_obj(obj, "old_string"),
            new_string: str_field_obj(obj, "new_string"),
            whole_file: false,
        }),
        _ => None,
    }
}

fn str_field_obj(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// 권한 요청에 대한 control_response(stdin으로 보낼 NDJSON 한 줄)를 만든다.
/// claude CLI가 기대하는 형태(추정): allow면 behavior="allow", deny면 "deny".
/// 우리가 직접 CRDT로 편집을 적용할 땐 deny로 보내 CLI의 직접 쓰기를 막는다.
pub fn build_permission_response(request_id: &str, allow: bool) -> String {
    let response = if allow {
        serde_json::json!({ "behavior": "allow" })
    } else {
        serde_json::json!({ "behavior": "deny", "message": "사용자가 거부했습니다" })
    };
    let line = serde_json::json!({
        "type": "control_response",
        "request_id": request_id,
        "response": response,
    });
    serde_json::to_string(&line).unwrap_or_default()
}

/// 승인된 편집을 base 텍스트에 적용해 새 전체 텍스트를 만든다 (순수 함수).
/// Write는 전체 교체, Edit은 old_string의 첫 일치를 new_string으로 치환한다.
/// claude의 Edit 의미와 맞춰 old_string이 없거나 여러 번 나오면 거부한다.
pub fn apply_tool_edit(base: &str, edit: &EditPreview) -> Result<String, String> {
    if edit.whole_file {
        return Ok(edit.new_string.clone());
    }
    if edit.old_string.is_empty() {
        return Err("빈 old_string은 편집할 수 없습니다".to_owned());
    }
    let count = base.matches(&edit.old_string).count();
    if count == 0 {
        return Err("찾는 내용이 파일에 없습니다".to_owned());
    }
    if count > 1 {
        return Err("찾는 내용이 여러 번 나타나 편집이 모호합니다".to_owned());
    }
    Ok(base.replacen(&edit.old_string, &edit.new_string, 1))
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// tool_use input에서 사람이 알아볼 만한 대표 값을 하나 고른다.
fn tool_detail(input: Option<&Value>) -> String {
    const KEYS: [&str; 7] = [
        "file_path",
        "path",
        "pattern",
        "command",
        "url",
        "query",
        "description",
    ];
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
                cost_usd: v
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
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
            dirs.push(
                home.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("claude"),
            );
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
        assert_eq!(
            events,
            vec![AgentEvent::Text {
                text: "PONG".into()
            }]
        );
    }

    #[test]
    fn parses_assistant_tool_use_with_detail() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"읽어볼게요"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/notes/README.md"}}]},"session_id":"s1"}"#;
        let events = parse_stream_line(line);
        assert_eq!(
            events,
            vec![
                AgentEvent::Text {
                    text: "읽어볼게요".into()
                },
                AgentEvent::ToolUse {
                    name: "Read".into(),
                    detail: "/notes/README.md".into()
                },
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
            [AgentEvent::Completed {
                ok: false,
                result,
                session_id,
                ..
            }] => {
                assert!(!result.is_empty());
                assert_eq!(session_id, "s2");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn ignores_unknown_event_types_and_garbage() {
        // 문서화되지 않은 타입(rate_limit_event 등)과 깨진 줄은 무시한다
        let rate_limit =
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"uuid":"u"}"#;
        assert!(parse_stream_line(rate_limit).is_empty());
        assert!(parse_stream_line("not json at all").is_empty());
        assert!(parse_stream_line("").is_empty());
        // 도구 결과(user 메시지)는 Phase 1에서 표시하지 않는다
        let user = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"..."}]}}"#;
        assert!(parse_stream_line(user).is_empty());
    }

    #[test]
    fn parses_control_request_for_edit_with_diff() {
        let line = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{"file_path":"/notes/a.md","old_string":"foo","new_string":"bar"}}}"#;
        match parse_control_request(line) {
            Some(AgentEvent::PermissionRequest {
                request_id,
                tool,
                edit: Some(edit),
                ..
            }) => {
                assert_eq!(request_id, "req-1");
                assert_eq!(tool, "Edit");
                assert_eq!(edit.file_path, "/notes/a.md");
                assert_eq!(edit.old_string, "foo");
                assert_eq!(edit.new_string, "bar");
                assert!(!edit.whole_file);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_control_request_for_write_as_whole_file() {
        let line = r##"{"type":"control_request","request_id":"req-2","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/notes/new.md","content":"# 새 파일\n본문"}}}"##;
        match parse_control_request(line) {
            Some(AgentEvent::PermissionRequest { edit: Some(e), .. }) => {
                assert!(e.whole_file);
                assert_eq!(e.old_string, "");
                assert_eq!(e.new_string, "# 새 파일\n본문");
                assert_eq!(e.file_path, "/notes/new.md");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_control_request_for_non_edit_tool_without_preview() {
        let line = r#"{"type":"control_request","request_id":"r3","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}"#;
        match parse_control_request(line) {
            Some(AgentEvent::PermissionRequest {
                tool, detail, edit, ..
            }) => {
                assert_eq!(tool, "Bash");
                assert_eq!(detail, "ls");
                assert!(edit.is_none());
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parse_control_request_ignores_unknown_and_garbage() {
        // 권한이 아닌 다른 control_request subtype은 무시한다
        let other_subtype =
            r#"{"type":"control_request","request_id":"x","request":{"subtype":"interrupt"}}"#;
        assert!(parse_control_request(other_subtype).is_none());
        // control_request가 아닌 줄은 무시
        assert!(parse_control_request(r#"{"type":"assistant"}"#).is_none());
        assert!(parse_control_request("not json").is_none());
        // request_id가 없으면 회신할 수 없으므로 무시
        let no_id =
            r#"{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Edit"}}"#;
        assert!(parse_control_request(no_id).is_none());
        // parse_stream_line은 control_request를 표시 이벤트로 만들지 않는다
        let req = r#"{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}"#;
        assert!(parse_stream_line(req).is_empty());
    }

    #[test]
    fn apply_tool_edit_write_replaces_whole_file() {
        let edit = EditPreview {
            file_path: "/a.md".into(),
            old_string: String::new(),
            new_string: "전체 새 내용".into(),
            whole_file: true,
        };
        assert_eq!(apply_tool_edit("옛 내용", &edit).unwrap(), "전체 새 내용");
    }

    #[test]
    fn apply_tool_edit_edit_replaces_unique_match() {
        let edit = EditPreview {
            file_path: "/a.md".into(),
            old_string: "foo".into(),
            new_string: "bar".into(),
            whole_file: false,
        };
        assert_eq!(apply_tool_edit("x foo y", &edit).unwrap(), "x bar y");
    }

    #[test]
    fn apply_tool_edit_rejects_missing_or_ambiguous() {
        let missing = EditPreview {
            file_path: "/a.md".into(),
            old_string: "zzz".into(),
            new_string: "q".into(),
            whole_file: false,
        };
        assert!(apply_tool_edit("hello", &missing).is_err());
        let ambiguous = EditPreview {
            file_path: "/a.md".into(),
            old_string: "a".into(),
            new_string: "b".into(),
            whole_file: false,
        };
        assert!(apply_tool_edit("a a", &ambiguous).is_err());
    }

    #[test]
    fn builds_allow_and_deny_responses() {
        let allow = build_permission_response("req-1", true);
        let v: Value = serde_json::from_str(&allow).unwrap();
        assert_eq!(v["type"], "control_response");
        assert_eq!(v["request_id"], "req-1");
        assert_eq!(v["response"]["behavior"], "allow");

        let deny = build_permission_response("req-2", false);
        let v: Value = serde_json::from_str(&deny).unwrap();
        assert_eq!(v["response"]["behavior"], "deny");
    }

    #[test]
    fn permission_request_serializes_camel_case() {
        let event = AgentEvent::PermissionRequest {
            request_id: "r1".into(),
            tool: "Edit".into(),
            detail: "/a.md".into(),
            edit: Some(EditPreview {
                file_path: "/a.md".into(),
                old_string: "x".into(),
                new_string: "y".into(),
                whole_file: false,
            }),
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["kind"], "permissionRequest");
        assert_eq!(json["requestId"], "r1");
        assert_eq!(json["edit"]["filePath"], "/a.md");
        assert_eq!(json["edit"]["oldString"], "x");
        assert_eq!(json["edit"]["wholeFile"], false);
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

        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };

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
