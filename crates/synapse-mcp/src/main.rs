//! Synapse MCP 서버 (stdio).
//!
//! 외부 에이전트(claude/codex 등)가 stdio로 실행하는 MCP 서버다. 실행 중인 Synapse
//! 앱의 loopback 브리지에 질의해 "지금 보고 있는 노트"(저장 전 편집 버퍼 포함)·열린
//! 탭·워크스페이스 검색/읽기를 도구로 노출한다.
//!
//! 브리지 접속 정보는 우선 환경변수로 받는다:
//! - `SYNAPSE_BRIDGE_PORT` — 앱이 바인드한 loopback 포트
//! - `SYNAPSE_BRIDGE_TOKEN` — 윈도우별 인증 토큰(이 토큰이 곧 윈도우 선택자)
//!
//! 외부 터미널에서 실행되는 이 사이드카는 앱의 자식 프로세스가 아니므로 위 env를
//! 상속받지 못한다. env가 없으면 `~/.config/synapse/bridge.json`(앱이 기록하는
//! 워크스페이스→접속정보 맵)을 읽어 현재 cwd의 조상 경로로 자신의 워크스페이스
//! 항목을 찾아 접속한다(`resolve_from`, `synapse_core::discovery`).
//!
//! 외부 MCP SDK 의존을 피하려고 JSON-RPC 2.0 / MCP stdio 프레이밍(개행 구분 JSON)을
//! 직접 구현한다. 디스크 검색/읽기는 사이드카가 로컬 프로세스이므로 `synapse-core`로
//! 직접 수행한다(앱은 라이브 상태만 제공).

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use synapse_core::{
    apply_auto_links, link_candidates, search_workspace, ApplyLink, Backend, LiveState, LocalBackend,
    RejectedLink, SearchOptions,
};

/// 브리지 접속 컨텍스트(환경변수 우선, 없으면 bridge.json에서 cwd로 발견해 1회 읽음).
struct Ctx {
    port: u16,
    token: String,
}

impl Ctx {
    fn from_env() -> Self {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let bridge_json = dirs::config_dir()
            .map(|d| d.join("synapse").join("bridge.json"))
            .and_then(|p| std::fs::read_to_string(p).ok());
        let resolved = resolve_from(
            std::env::var("SYNAPSE_BRIDGE_PORT").ok(),
            std::env::var("SYNAPSE_BRIDGE_TOKEN").ok(),
            bridge_json.as_deref(),
            &cwd,
        );
        match resolved {
            Some((port, token)) => Ctx { port, token },
            None => Ctx {
                port: 0,
                token: String::new(),
            },
        }
    }

    /// 앱 브리지에서 현재 윈도우의 라이브 상태를 가져온다.
    fn fetch_live(&self) -> Result<LiveState, String> {
        if self.port == 0 || self.token.is_empty() {
            return Err(
                "Synapse 브리지를 찾을 수 없습니다. 이 폴더(또는 상위 폴더)를 Synapse 앱에서 열어 두세요."
                    .to_string(),
            );
        }
        let url = format!("http://127.0.0.1:{}/live", self.port);
        let resp = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|e| {
                format!("Synapse 앱 브리지에 접속할 수 없습니다(앱이 실행 중인가요?): {e}")
            })?;
        resp.into_json::<LiveState>()
            .map_err(|e| format!("브리지 응답을 해석할 수 없습니다: {e}"))
    }

    /// 앱 브리지에 노트 쓰기를 요청한다. CRDT로 적용된 최종(병합) 텍스트를 돌려받는다.
    fn post_edit(
        &self,
        path: &str,
        new_content: &str,
        base_content: &str,
    ) -> Result<String, String> {
        if self.port == 0 || self.token.is_empty() {
            return Err(
                "Synapse 브리지를 찾을 수 없습니다. 이 폴더(또는 상위 폴더)를 Synapse 앱에서 열어 두세요."
                    .to_string(),
            );
        }
        let url = format!("http://127.0.0.1:{}/edit", self.port);
        let body = json!({
            "path": path,
            "newContent": new_content,
            "baseContent": base_content,
        });
        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body)
            .map_err(|e| match e {
                ureq::Error::Status(code, resp) => {
                    let detail = resp.into_string().unwrap_or_default();
                    format!("브리지가 쓰기를 거부함({code}): {detail}")
                }
                other => format!("Synapse 앱 브리지에 쓰기 요청 실패: {other}"),
            })?;
        let v: Value = resp
            .into_json()
            .map_err(|e| format!("브리지 응답을 해석할 수 없습니다: {e}"))?;
        Ok(v.get("merged")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    }
}

fn main() {
    let ctx = Ctx::from_env();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    // MCP stdio 전송: 한 줄당 완전한 JSON-RPC 메시지 1개(개행 구분).
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            // 파싱 불가 메시지는 JSON-RPC parse error로 응답(id 모르면 null).
            Err(_) => {
                let _ = write_message(
                    &mut stdout,
                    &err_response(Value::Null, -32700, "parse error"),
                );
                continue;
            }
        };
        if let Some(response) = handle(&msg, &ctx) {
            if write_message(&mut stdout, &response).is_err() {
                break;
            }
        }
    }
}

/// 메시지 한 건을 처리한다. 응답이 필요 없으면(알림) `None`.
fn handle(msg: &Value, ctx: &Ctx) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let is_notification = id.is_none();

    match method {
        "initialize" => Some(ok_response(id, initialize_result(msg))),
        // 클라이언트 초기화 완료 알림 — 응답 없음.
        "notifications/initialized" => None,
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, json!({ "tools": tool_defs() }))),
        "tools/call" => Some(handle_tool_call(id, msg, ctx)),
        // 모르는 알림은 무시, 모르는 요청은 method-not-found.
        _ if is_notification => None,
        _ => Some(err_response(
            id.unwrap_or(Value::Null),
            -32601,
            "method not found",
        )),
    }
}

fn initialize_result(msg: &Value) -> Value {
    // 클라이언트가 요청한 프로토콜 버전을 그대로 echo(상호운용 안전), 없으면 기본값.
    let pv = msg
        .pointer("/params/protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    json!({
        "protocolVersion": pv,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "synapse", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// MCP 도구 정의(이름/설명/입력 스키마). 순수 데이터라 단위 테스트로 검증한다.
fn tool_defs() -> Value {
    json!([
        {
            "name": "get_current_note",
            "description": "Synapse에서 사용자가 지금 보고 있는 노트의 경로와 내용을 가져온다. 저장 전 편집 버퍼까지 반영된 최신 화면 내용이다.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "list_open_tabs",
            "description": "Synapse에서 현재 열려 있는 모든 노트 탭의 경로 목록을 가져온다.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "read_note",
            "description": "워크스페이스 안의 특정 노트 내용을 읽는다. 그 노트가 현재 활성 노트면 저장 전 라이브 버퍼를, 아니면 디스크 내용을 돌려준다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "노트의 절대 경로(워크스페이스 루트 내부)" }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        },
        {
            "name": "search_notes",
            "description": "현재 워크스페이스 전체에서 텍스트를 검색한다(파일명+내용). 매칭된 노트 경로와 스니펫을 돌려준다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "검색어" }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "edit_note",
            "description": "노트를 주어진 전체 내용으로 저장한다(없으면 생성). CRDT로 사용자 편집과 안전하게 병합되고, 열려 있으면 에디터에 곧바로 반영된다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "노트의 절대 경로(워크스페이스 루트 내부)" },
                    "content": { "type": "string", "description": "저장할 전체 새 내용(frontmatter 포함)" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }
        },
        {
            "name": "link_candidates",
            "description": "워크스페이스 노트 간 자동 연결 후보를 휴리스틱으로 계산한다(제목 언급·키워드 중복·공통 이웃). 결과는 JSON 배열: {from,to,score,reasons,existing}. existing=true는 이미 auto-links 블록에 있는 연결이며, apply_links는 파일별 전량 교체이므로 유지할 후보도 최종 목록에 포함해야 한다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "이 노트들(절대 경로)이 from인 후보만 계산(증분). 생략하면 전체." },
                    "limit": { "type": "number", "description": "최대 후보 수(기본 50)" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "apply_links",
            "description": "확정한 노트 연결을 각 from 노트 하단의 auto-links 마커 블록에 wikilink로 기록한다. 선언적: 전달한 links가 각 from 파일 블록의 전체 내용이 된다(해당 from에 빈 목록 = 블록 제거). 마커 밖 본문은 절대 바꾸지 않으며 사용자 편집과 안전하게 병합된다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "links": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": { "type": "string", "description": "링크를 담을 노트의 절대 경로" },
                                "to": { "type": "string", "description": "링크 대상 노트의 절대 경로" },
                                "label": { "type": "string", "description": "선택: 연결 이유 한 줄(— 뒤에 표시)" }
                            },
                            "required": ["from", "to"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["links"],
                "additionalProperties": false
            }
        }
    ])
}

fn handle_tool_call(id: Option<Value>, msg: &Value, ctx: &Ctx) -> Value {
    let id = id.unwrap_or(Value::Null);
    let name = msg
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = msg
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or(json!({}));

    let result: Result<String, String> = match name {
        "get_current_note" => ctx.fetch_live().map(|live| format_current_note(&live)),
        "list_open_tabs" => ctx.fetch_live().map(|live| format_open_tabs(&live)),
        "read_note" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() {
                Err("path 인자가 필요합니다".to_string())
            } else {
                ctx.fetch_live().and_then(|live| read_note(&live, path))
            }
        }
        "search_notes" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
            ctx.fetch_live().and_then(|live| search_notes(&live, query))
        }
        "edit_note" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() {
                Err("path 인자가 필요합니다".to_string())
            } else {
                ctx.fetch_live().and_then(|live| {
                    // 기준(base)은 에이전트가 본 현재 내용 — 활성 노트면 라이브 버퍼,
                    // 아니면 디스크. 새 노트면 빈 문자열.
                    let base = read_note(&live, path).unwrap_or_default();
                    ctx.post_edit(path, content, &base)
                        .map(|merged| format!("'{path}' 저장됨.\n\n---\n{merged}"))
                })
            }
        }
        "link_candidates" => ctx
            .fetch_live()
            .and_then(|live| link_candidates_tool(&live, &args)),
        "apply_links" => ctx.fetch_live().and_then(|live| {
            let plans = plan_apply_links(&live, &args)?;
            let mut out = String::from("# apply_links 결과\n");
            for p in plans {
                if p.new_content != p.base {
                    ctx.post_edit(&p.path, &p.new_content, &p.base)?;
                }
                out.push_str(&format!("\n## {}\n- 적용 {}건", p.path, p.applied));
                for r in &p.rejected {
                    out.push_str(&format!("\n- 거부: {} — {}", r.to, r.reason));
                }
                for w in &p.warnings {
                    out.push_str(&format!("\n- 경고: {w}"));
                }
                out.push('\n');
            }
            Ok(out)
        }),
        other => Err(format!("알 수 없는 도구: {other}")),
    };

    match result {
        Ok(text) => ok_response(Some(id), tool_text(&text, false)),
        // 도구 실행 오류는 JSON-RPC 오류가 아니라 result content(isError=true)로 전달한다(MCP 규약).
        Err(e) => ok_response(Some(id), tool_text(&e, true)),
    }
}

// ----- 도구 로직 (순수 함수) -----

fn format_current_note(live: &LiveState) -> String {
    match (&live.active_path, &live.active_content) {
        (Some(path), Some(content)) => format!("# 현재 노트\n경로: {path}\n\n---\n{content}"),
        (Some(path), None) => {
            format!("현재 노트({path})는 텍스트 노트가 아니라 내용을 읽을 수 없습니다.")
        }
        (None, _) => "현재 열려 있는 노트가 없습니다.".to_string(),
    }
}

fn format_open_tabs(live: &LiveState) -> String {
    if live.open_tabs.is_empty() {
        return "열려 있는 탭이 없습니다.".to_string();
    }
    let active = live.active_path.as_deref().unwrap_or("");
    let mut out = String::from("# 열린 탭\n");
    for tab in &live.open_tabs {
        let marker = if tab.path == active { " (현재)" } else { "" };
        out.push_str(&format!("- {} [{}]{}\n", tab.path, tab.file_type, marker));
    }
    out
}

fn read_note(live: &LiveState, path: &str) -> Result<String, String> {
    // 활성 노트면 저장 전 라이브 버퍼를 우선한다.
    if live.active_path.as_deref() == Some(path) {
        if let Some(content) = &live.active_content {
            return Ok(content.clone());
        }
    }
    let root = live
        .root
        .as_deref()
        .ok_or_else(|| "열린 워크스페이스가 없습니다.".to_string())?;
    if root.starts_with("ssh://") {
        return Err("원격(SSH) 워크스페이스는 아직 MCP에서 지원하지 않습니다.".to_string());
    }
    let backend = LocalBackend;
    let resolved = backend
        .ensure_within(Path::new(root), Path::new(path))
        .map_err(|e| e.to_string())?;
    backend.read_to_string(&resolved).map_err(|e| e.to_string())
}

fn search_notes(live: &LiveState, query: &str) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("query 인자가 필요합니다".to_string());
    }
    let root = live
        .root
        .as_deref()
        .ok_or_else(|| "열린 워크스페이스가 없습니다.".to_string())?;
    if root.starts_with("ssh://") {
        return Err("원격(SSH) 워크스페이스는 아직 MCP에서 지원하지 않습니다.".to_string());
    }
    let hits = search_workspace(Path::new(root), query, &SearchOptions::default());
    if hits.is_empty() {
        return Ok(format!("'{query}'에 대한 검색 결과가 없습니다."));
    }
    let mut out = format!("# '{query}' 검색 결과 ({}건)\n", hits.len());
    for hit in &hits {
        out.push_str(&format!("\n## {}\n경로: {}\n", hit.name, hit.path));
        for m in &hit.matches {
            out.push_str(&format!("  {}: {}\n", m.line, m.snippet));
        }
    }
    Ok(out)
}

/// 워크스페이스 루트를 얻는다(원격 제외) — 기존 read_note/search_notes와 동일 규약.
fn local_root(live: &LiveState) -> Result<String, String> {
    let root = live
        .root
        .as_deref()
        .ok_or_else(|| "열린 워크스페이스가 없습니다.".to_string())?;
    if root.starts_with("ssh://") {
        return Err("원격(SSH) 워크스페이스는 아직 MCP에서 지원하지 않습니다.".to_string());
    }
    Ok(root.to_string())
}

fn link_candidates_tool(live: &LiveState, args: &Value) -> Result<String, String> {
    let root = local_root(live)?;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
    let paths: Vec<PathBuf> = args
        .get("paths")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_default();
    let cands = link_candidates(Path::new(&root), &paths, limit)
        .map_err(|e| format!("후보 계산 실패: {e}"))?;
    serde_json::to_string_pretty(&cands).map_err(|e| format!("직렬화 실패: {e}"))
}

/// apply_links 한 파일 분량의 쓰기 계획(테스트 가능한 순수 계획 단계).
struct PlannedEdit {
    path: String,
    base: String,
    new_content: String,
    applied: usize,
    rejected: Vec<RejectedLink>,
    warnings: Vec<String>,
}

/// links 인자를 from별로 묶어(입력 순서 보존) 각 파일의 재작성 내용을 계산한다.
/// 디스크에 쓰지 않는다 — 쓰기는 호출자가 post_edit으로 수행.
fn plan_apply_links(live: &LiveState, args: &Value) -> Result<Vec<PlannedEdit>, String> {
    let root = local_root(live)?;
    let links = args
        .get("links")
        .and_then(Value::as_array)
        .ok_or_else(|| "links 배열 인자가 필요합니다".to_string())?;

    // from별 그룹(입력 순서 보존)
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<ApplyLink>> =
        std::collections::HashMap::new();
    for l in links {
        let from = l
            .get("from")
            .and_then(Value::as_str)
            .ok_or_else(|| "각 링크에 from이 필요합니다".to_string())?
            .to_string();
        let link: ApplyLink = serde_json::from_value(l.clone())
            .map_err(|e| format!("링크 항목 해석 실패: {e}"))?;
        if !groups.contains_key(&from) {
            order.push(from.clone());
        }
        groups.entry(from).or_default().push(link);
    }

    let mut plans = Vec::new();
    for from in order {
        let base = read_note(live, &from)?;
        let outcome = apply_auto_links(
            Path::new(&root),
            Path::new(&from),
            &base,
            &groups[&from],
        )
        .map_err(|e| e.to_string())?;
        plans.push(PlannedEdit {
            path: from,
            base,
            new_content: outcome.content,
            applied: outcome.applied,
            rejected: outcome.rejected,
            warnings: outcome.warnings,
        });
    }
    Ok(plans)
}

// ----- JSON-RPC / MCP 프레이밍 헬퍼 -----

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": is_error
    })
}

fn ok_response(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

fn err_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn write_message<W: Write>(out: &mut W, msg: &Value) -> std::io::Result<()> {
    let line = serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string());
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

/// (port, token)을 결정한다: env 우선, 없으면 bridge.json에서 cwd로 찾는다.
fn resolve_from(
    env_port: Option<String>,
    env_token: Option<String>,
    bridge_json: Option<&str>,
    cwd: &str,
) -> Option<(u16, String)> {
    if let (Some(p), Some(t)) = (env_port.as_deref(), env_token.as_deref()) {
        if let Ok(port) = p.parse::<u16>() {
            if !t.is_empty() {
                return Some((port, t.to_string()));
            }
        }
    }
    let map = synapse_core::discovery::parse(bridge_json?);
    let e = synapse_core::discovery::find_for_cwd(&map, cwd)?;
    Some((e.port, e.token))
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    #[test]
    fn env_takes_precedence() {
        let r = resolve_from(Some("111".into()), Some("tok".into()), None, "/ws");
        assert_eq!(r, Some((111, "tok".to_string())));
    }

    #[test]
    fn falls_back_to_bridge_json_by_cwd() {
        let json = r#"{"/ws":{"port":222,"token":"jtok","pid":1}}"#;
        let r = resolve_from(None, None, Some(json), "/ws/sub");
        assert_eq!(r, Some((222, "jtok".to_string())));
    }

    #[test]
    fn none_when_no_env_and_no_match() {
        assert_eq!(resolve_from(None, None, Some("{}"), "/ws"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use synapse_core::OpenTab;

    fn live_with_note() -> LiveState {
        LiveState {
            root: Some("/ws".to_string()),
            active_path: Some("/ws/a.md".to_string()),
            active_content: Some("# A\n저장 전 편집".to_string()),
            open_tabs: vec![
                OpenTab {
                    path: "/ws/a.md".to_string(),
                    name: "a.md".to_string(),
                    file_type: "markdown".to_string(),
                },
                OpenTab {
                    path: "/ws/b.md".to_string(),
                    name: "b.md".to_string(),
                    file_type: "markdown".to_string(),
                },
            ],
        }
    }

    #[test]
    fn tool_defs_list_tools_with_object_schemas() {
        let defs = tool_defs();
        let arr = defs.as_array().unwrap();
        assert_eq!(arr.len(), 7);
        let names: Vec<&str> = arr.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"get_current_note"));
        assert!(names.contains(&"read_note"));
        assert!(names.contains(&"search_notes"));
        assert!(names.contains(&"edit_note"));
        for t in arr {
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn initialize_echoes_protocol_version_and_advertises_tools() {
        let req = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        });
        let res = initialize_result(&req);
        assert_eq!(res["protocolVersion"], "2024-11-05");
        assert!(res["capabilities"]["tools"].is_object());
        assert_eq!(res["serverInfo"]["name"], "synapse");
    }

    #[test]
    fn current_note_includes_live_buffer() {
        let text = format_current_note(&live_with_note());
        assert!(text.contains("/ws/a.md"));
        assert!(text.contains("저장 전 편집"));
    }

    #[test]
    fn current_note_handles_empty() {
        let text = format_current_note(&LiveState::default());
        assert!(text.contains("열려 있는 노트가 없습니다"));
    }

    #[test]
    fn open_tabs_marks_active() {
        let text = format_open_tabs(&live_with_note());
        assert!(text.contains("/ws/a.md"));
        assert!(text.contains("(현재)"));
        assert!(text.contains("/ws/b.md"));
    }

    #[test]
    fn read_note_prefers_live_buffer_for_active() {
        let out = read_note(&live_with_note(), "/ws/a.md").unwrap();
        assert_eq!(out, "# A\n저장 전 편집");
    }

    #[test]
    fn read_note_rejects_remote_root() {
        let live = LiveState {
            root: Some("ssh://host/ws".to_string()),
            active_path: None,
            active_content: None,
            open_tabs: vec![],
        };
        assert!(read_note(&live, "/ws/x.md").is_err());
    }

    #[test]
    fn handle_unknown_request_is_method_not_found() {
        let ctx = Ctx {
            port: 0,
            token: String::new(),
        };
        let req = json!({ "jsonrpc": "2.0", "id": 7, "method": "nope" });
        let res = handle(&req, &ctx).unwrap();
        assert_eq!(res["error"]["code"], -32601);
        assert_eq!(res["id"], 7);
    }

    #[test]
    fn handle_initialized_notification_has_no_response() {
        let ctx = Ctx {
            port: 0,
            token: String::new(),
        };
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&note, &ctx).is_none());
    }

    #[test]
    fn tool_call_without_bridge_returns_iserror_result() {
        let ctx = Ctx {
            port: 0,
            token: String::new(),
        };
        let req = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "get_current_note", "arguments": {} }
        });
        let res = handle(&req, &ctx).unwrap();
        // JSON-RPC 오류가 아니라 result.isError=true로 전달돼야 한다.
        assert!(res.get("error").is_none());
        assert_eq!(res["result"]["isError"], true);
        assert!(res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("브리지"));
    }

    #[test]
    fn tool_defs_include_autolink_tools() {
        let defs = tool_defs();
        let arr = defs.as_array().unwrap();
        assert_eq!(arr.len(), 7);
        let names: Vec<&str> = arr.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"link_candidates"));
        assert!(names.contains(&"apply_links"));
    }

    #[test]
    fn link_candidates_tool_returns_json() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("cilium.md"), "# Cilium").unwrap();
        std::fs::write(root.join("k8s.md"), "cilium 언급").unwrap();
        let live = LiveState {
            root: Some(root.display().to_string()),
            active_path: None,
            active_content: None,
            open_tabs: vec![],
        };
        let out = link_candidates_tool(&live, &json!({})).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.as_array().unwrap().iter().any(|c| {
            c["from"].as_str().unwrap().ends_with("k8s.md")
                && c["to"].as_str().unwrap().ends_with("cilium.md")
        }));
    }

    #[test]
    fn plan_apply_links_groups_by_from_and_rewrites() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("from.md"), "본문\n").unwrap();
        std::fs::write(root.join("b.md"), "# b").unwrap();
        let live = LiveState {
            root: Some(root.display().to_string()),
            active_path: None,
            active_content: None,
            open_tabs: vec![],
        };
        let args = json!({ "links": [
            { "from": root.join("from.md").display().to_string(),
              "to": root.join("b.md").display().to_string(),
              "label": "설명" }
        ]});
        let plans = plan_apply_links(&live, &args).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].base, "본문\n");
        assert!(plans[0].new_content.contains("- [[b]] — 설명"));
        assert_eq!(plans[0].applied, 1);
    }

    #[test]
    fn plan_apply_links_requires_links_array() {
        let live = LiveState {
            root: Some("/ws".to_string()),
            active_path: None,
            active_content: None,
            open_tabs: vec![],
        };
        assert!(plan_apply_links(&live, &json!({})).is_err());
    }
}
