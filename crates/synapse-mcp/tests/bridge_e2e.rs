//! 사이드카 ↔ 브리지 E2E 통합 테스트.
//!
//! 실제 `synapse-mcp` 바이너리를 띄우고, 앱 브리지를 흉내 내는 stub HTTP 서버를
//! 물린 뒤, stdio로 MCP JSON-RPC를 주고받아 read 경로(현재 노트/탭/읽기/검색)가
//! 끝에서 끝까지 동작하는지 확인한다. claude/codex가 이 바이너리를 실행했을 때와
//! 동일한 계약을 검증한다.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

const TOKEN: &str = "test-token-0123456789abcdef";

/// 앱 브리지 흉내: `GET /live`에 Bearer 토큰이 맞으면 주어진 LiveState JSON을 돌려준다.
/// 사이드카가 도구 호출마다 새로 접속하므로 무한 루프로 연결을 받는다(테스트 종료 시 누수 무방).
fn start_stub_bridge(live_json: String) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                continue;
            }
            // 헤더에서 Authorization만 본다.
            let mut authorized = false;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    break;
                }
                if let Some((name, value)) = trimmed.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("authorization")
                        && value.trim() == format!("Bearer {TOKEN}")
                    {
                        authorized = true;
                    }
                }
            }
            let (status, body) = if authorized {
                ("200 OK", live_json.clone())
            } else {
                (
                    "401 Unauthorized",
                    "{\"error\":\"unauthorized\"}".to_string(),
                )
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    port
}

/// JSON-RPC 메시지 한 건을 보내고, 같은 id의 응답을 받을 때까지 stdout을 읽는다.
fn rpc(
    stdin: &mut impl Write,
    reader: &mut impl BufRead,
    id: i64,
    method: &str,
    params: Value,
) -> Value {
    let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap();
        assert!(
            n > 0,
            "사이드카가 응답 전에 stdout을 닫음 (method={method})"
        );
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = serde_json::from_str(trimmed).expect("유효한 JSON-RPC 응답");
        if msg.get("id") == Some(&json!(id)) {
            return msg;
        }
        // 다른 id/알림은 무시하고 계속 읽는다.
    }
}

/// 알림(응답 없음)을 보낸다.
fn notify(stdin: &mut impl Write, method: &str) {
    let msg = json!({ "jsonrpc": "2.0", "method": method });
    writeln!(stdin, "{msg}").unwrap();
    stdin.flush().unwrap();
}

/// tools/call 결과에서 첫 text content를 꺼낸다.
fn tool_text(result: &Value) -> String {
    result["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[test]
fn sidecar_serves_current_note_and_reads_over_stdio() {
    // 임시 워크스페이스: 활성 노트(디스크)와 다른 노트.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_string_lossy().to_string();
    let active = format!("{root}/note.md");
    let other = format!("{root}/other.md");
    // 활성 노트의 디스크 내용은 라이브 버퍼와 다르게 둔다 — read_note(active)가
    // 디스크가 아니라 라이브 버퍼를 우선하는지 확인하려고.
    std::fs::write(&active, "# Disk\n디스크에 저장된 옛 내용").unwrap();
    std::fs::write(&other, "# Other\nfindme 키워드가 여기 있다").unwrap();

    let live = json!({
        "root": root,
        "activePath": active,
        "activeContent": "# Live\n아직 저장 안 한 버퍼 내용",
        "openTabs": [
            { "path": active, "name": "note.md", "fileType": "markdown" },
            { "path": other, "name": "other.md", "fileType": "markdown" }
        ]
    });
    let port = start_stub_bridge(live.to_string());

    let mut child = Command::new(env!("CARGO_BIN_EXE_synapse-mcp"))
        .env("SYNAPSE_BRIDGE_PORT", port.to_string())
        .env("SYNAPSE_BRIDGE_TOKEN", TOKEN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("synapse-mcp 바이너리 실행");

    let mut stdin = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());

    // 1) initialize
    let init = rpc(
        &mut stdin,
        &mut reader,
        1,
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } }),
    );
    assert_eq!(init["result"]["serverInfo"]["name"], "synapse");
    notify(&mut stdin, "notifications/initialized");

    // 2) tools/list — 도구 4종
    let tools = rpc(&mut stdin, &mut reader, 2, "tools/list", json!({}));
    let names: Vec<String> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"get_current_note".to_string()));
    assert!(names.contains(&"read_note".to_string()));
    assert!(names.contains(&"search_notes".to_string()));

    // 3) get_current_note — 라이브 버퍼가 와야 한다
    let cur = rpc(
        &mut stdin,
        &mut reader,
        3,
        "tools/call",
        json!({ "name": "get_current_note", "arguments": {} }),
    );
    let cur_text = tool_text(&cur);
    assert!(
        cur_text.contains("아직 저장 안 한 버퍼 내용"),
        "라이브 버퍼: {cur_text}"
    );
    assert!(cur_text.contains("note.md"));

    // 4) read_note(active) — 디스크가 아니라 라이브 버퍼 우선
    let read_active = rpc(
        &mut stdin,
        &mut reader,
        4,
        "tools/call",
        json!({ "name": "read_note", "arguments": { "path": active } }),
    );
    let ra = tool_text(&read_active);
    assert!(
        ra.contains("아직 저장 안 한 버퍼 내용"),
        "활성 노트는 라이브 우선: {ra}"
    );
    assert!(!ra.contains("디스크에 저장된 옛 내용"));

    // 5) read_note(other) — 디스크 내용
    let read_other = rpc(
        &mut stdin,
        &mut reader,
        5,
        "tools/call",
        json!({ "name": "read_note", "arguments": { "path": other } }),
    );
    assert!(tool_text(&read_other).contains("findme 키워드"));

    // 6) search_notes — 디스크 검색으로 other.md를 찾는다
    let search = rpc(
        &mut stdin,
        &mut reader,
        6,
        "tools/call",
        json!({ "name": "search_notes", "arguments": { "query": "findme" } }),
    );
    assert!(
        tool_text(&search).contains("other.md"),
        "검색 결과: {}",
        tool_text(&search)
    );

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn sidecar_without_bridge_env_reports_error_not_crash() {
    // 브리지 env 없이 실행하면 도구 호출이 isError 결과로 안내해야 한다(크래시 X).
    let mut child = Command::new(env!("CARGO_BIN_EXE_synapse-mcp"))
        .env_remove("SYNAPSE_BRIDGE_PORT")
        .env_remove("SYNAPSE_BRIDGE_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("synapse-mcp 바이너리 실행");
    let mut stdin = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());

    rpc(
        &mut stdin,
        &mut reader,
        1,
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {} }),
    );
    let cur = rpc(
        &mut stdin,
        &mut reader,
        2,
        "tools/call",
        json!({ "name": "get_current_note", "arguments": {} }),
    );
    assert!(
        cur.get("error").is_none(),
        "JSON-RPC 오류가 아니라 isError 결과여야 함"
    );
    assert_eq!(cur["result"]["isError"], true);

    let _ = child.kill();
    let _ = child.wait();
    // stdin을 명시적으로 닫아 자식 메인 루프가 끝나게 한다.
    drop(stdin);
    let mut _sink = String::new();
    let _ = reader.read_to_string(&mut _sink);
}
