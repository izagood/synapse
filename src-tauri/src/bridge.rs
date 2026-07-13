//! 라이브 상태 브리지 서버 (앱 측).
//!
//! 실행 중인 Synapse 앱이 `127.0.0.1`의 임시 포트에 작은 HTTP 서버를 띄워, 각
//! 윈도우의 "지금 보고 있는" 라이브 상태([`synapse_core::LiveState`])를 노출한다.
//! 외부 에이전트가 띄운 Synapse MCP 사이드카가 이 서버에 질의해 현재 노트/탭을
//! 가져간다.
//!
//! 보안 모델: **토큰이 곧 윈도우 선택자**다. 윈도우마다 무작위 토큰을 발급하고,
//! `GET /live`는 `Authorization: Bearer <token>`으로 인증과 "어느 윈도우냐"를 동시에
//! 결정한다. 따라서 한 윈도우의 토큰으로 다른 윈도우의 노트를 훔쳐볼 수 없다.
//! 서버는 loopback에만 바인드하므로 원격 접근은 불가능하다.
//!
//! 의존성을 늘리지 않기 위해 외부 HTTP 프레임워크 없이 `std::net`으로 최소한의
//! HTTP/1.1만 처리한다(GET 두 개, Connection: close).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use synapse_core::{generate_token, token_matches, LiveState};

/// 한 윈도우의 브리지 세션: 인증 토큰 + 마지막으로 받은 라이브 상태.
struct Session {
    token: String,
    live: LiveState,
}

/// 브리지 공유 상태. Tauri 관리 상태와 서버 스레드가 `Arc`로 공유한다.
pub struct BridgeInner {
    /// 윈도우 라벨 → 세션.
    sessions: Mutex<HashMap<String, Session>>,
    /// 바인드된 loopback 포트(0이면 아직 미기동).
    port: AtomicU16,
}

impl BridgeInner {
    fn new() -> Self {
        BridgeInner {
            sessions: Mutex::new(HashMap::new()),
            port: AtomicU16::new(0),
        }
    }

    /// 윈도우의 토큰을 보장한다(없으면 생성). 라이브 상태는 기본값으로 시작.
    /// PTY 스폰 시 자식 env에 실어 보낼 (포트, 토큰)을 얻는 용도.
    pub fn ensure_token(&self, label: &str) -> String {
        let mut sessions = self.sessions.lock().unwrap();
        sessions
            .entry(label.to_string())
            .or_insert_with(|| Session {
                token: generate_token(),
                live: LiveState::default(),
            })
            .token
            .clone()
    }

    /// 바인드된 포트. 서버 기동 전이면 0.
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    /// 윈도우의 라이브 상태를 갱신한다(토큰은 없으면 생성).
    fn push(&self, label: &str, live: LiveState) {
        let mut sessions = self.sessions.lock().unwrap();
        match sessions.get_mut(label) {
            Some(s) => s.live = live,
            None => {
                sessions.insert(
                    label.to_string(),
                    Session {
                        token: generate_token(),
                        live,
                    },
                );
            }
        }
    }

    /// 윈도우가 닫힐 때 세션을 제거해 메모리/토큰 누수를 막는다.
    pub fn drop_window(&self, label: &str) {
        self.sessions.lock().unwrap().remove(label);
    }

    /// 토큰으로 세션을 찾아 라이브 상태를 복제해 돌려준다(상수 시간 비교).
    fn live_for_token(&self, token: &str) -> Option<LiveState> {
        let sessions = self.sessions.lock().unwrap();
        for s in sessions.values() {
            if token_matches(&s.token, token) {
                return Some(s.live.clone());
            }
        }
        None
    }
}

/// Tauri 관리 상태로 등록할 핸들.
#[derive(Clone)]
pub struct BridgeState(pub Arc<BridgeInner>);

impl Default for BridgeState {
    fn default() -> Self {
        BridgeState(Arc::new(BridgeInner::new()))
    }
}

/// 프론트가 활성 노트/탭/내용 변경 시 디바운스로 호출해 라이브 상태를 올린다.
#[tauri::command]
pub fn bridge_push_state(
    state: tauri::State<'_, BridgeState>,
    window_label: String,
    live: LiveState,
) -> Result<(), String> {
    state.0.push(&window_label, live);
    Ok(())
}

/// loopback HTTP 서버를 기동한다. `setup`에서 한 번 호출.
///
/// 바인드에 실패하면(예: 포트 고갈) 브리지 기능만 비활성화되고 앱 본체는 정상
/// 동작하도록 에러를 삼킨다(로그만).
pub fn start(inner: Arc<BridgeInner>) {
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("synapse bridge: bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("synapse bridge: local_addr failed: {e}");
            return;
        }
    };
    inner.port.store(port, Ordering::Relaxed);

    std::thread::Builder::new()
        .name("synapse-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        let inner = inner.clone();
                        // 연결당 짧은 처리. loopback이라 동시성이 낮아 스레드/연결로 충분.
                        std::thread::spawn(move || {
                            let _ = handle_conn(s, &inner);
                        });
                    }
                    Err(_) => continue,
                }
            }
        })
        .expect("failed to spawn synapse bridge thread");
}

/// 요청 한 건을 처리한다. 지원: `GET /health`(무인증), `GET /live`(Bearer 토큰).
fn handle_conn(stream: TcpStream, inner: &BridgeInner) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream);

    // 요청 라인: "GET /live HTTP/1.1"
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    // 경로만(쿼리 무시). 토큰은 헤더로만 받는다(URL에 비밀을 남기지 않음).
    let path = target.split('?').next().unwrap_or("");

    // 헤더 파싱: 빈 줄까지. Authorization과 Content-Length를 본다.
    let mut bearer: Option<String> = None;
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim();
            if name.eq_ignore_ascii_case("authorization") {
                let v = value.trim();
                if let Some(tok) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
                    bearer = Some(tok.trim().to_string());
                }
            } else if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    // POST 본문(있으면) 읽기 — Content-Length만큼.
    let mut body = Vec::new();
    if content_length > 0 {
        body.resize(content_length, 0);
        if reader.read_exact(&mut body).is_err() {
            body.clear();
        }
    }

    let mut stream = reader.into_inner();
    match (method, path) {
        ("GET", "/health") => write_response(&mut stream, 200, "application/json", b"{\"ok\":true}"),
        ("GET", "/live") => match bearer.as_deref().and_then(|t| inner.live_for_token(t)) {
            Some(live) => {
                let body = serde_json::to_vec(&live).unwrap_or_else(|_| b"{}".to_vec());
                write_response(&mut stream, 200, "application/json", &body)
            }
            None => write_response(
                &mut stream,
                401,
                "application/json",
                b"{\"error\":\"unauthorized\"}",
            ),
        },
        // 노트 쓰기 — 토큰이 가리키는 윈도우의 워크스페이스 루트 내부로 제한.
        ("POST", "/edit") => match bearer.as_deref().and_then(|t| inner.live_for_token(t)) {
            Some(live) => match apply_edit_request(&live, &body) {
                Ok(merged) => {
                    let payload = serde_json::json!({ "merged": merged });
                    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
                    write_response(&mut stream, 200, "application/json", &bytes)
                }
                Err(e) => {
                    let payload = serde_json::json!({ "error": e });
                    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
                    write_response(&mut stream, 400, "application/json", &bytes)
                }
            },
            None => write_response(
                &mut stream,
                401,
                "application/json",
                b"{\"error\":\"unauthorized\"}",
            ),
        },
        _ => write_response(
            &mut stream,
            404,
            "application/json",
            b"{\"error\":\"not found\"}",
        ),
    }
}

/// `POST /edit` 요청 본문.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditRequest {
    /// 대상 노트 경로(워크스페이스 루트 내부).
    path: String,
    /// 적용 후 전체 내용.
    new_content: String,
    /// 에이전트가 본 기준 내용(CRDT diff 기준).
    base_content: String,
}

/// `/edit` 본문을 파싱해 현재 디스크 내용과 stateless 3-way 병합한 뒤 원자적으로
/// 쓰고, 합쳐진 텍스트를 돌려준다. 병합은 상태를 남기지 않으므로(디스크가 유일한
/// 진실) 동시에 열려 있는 에디터의 편집과도 자동으로 합쳐지며, 디스크 쓰기는
/// 파일 워처를 통해 열린 에디터에 반영된다.
fn apply_edit_request(live: &LiveState, body: &[u8]) -> Result<String, String> {
    use std::path::Path;
    use synapse_core::{merge_agent_edit, Backend, LocalBackend};

    // 브리지는 커넥션당 스레드로 요청을 처리하므로, 동시 /edit 두 건이 같은
    // 디스크 스냅샷을 읽고 각자 병합해 나중 write가 먼저 것을 덮어쓸 수 있다.
    // read→merge→write 시퀀스를 직렬화해 lost update를 막는다
    // (구 CRDT 스토어 workspace_lock의 유일한 잔존 역할).
    static EDIT_LOCK: Mutex<()> = Mutex::new(());

    let req: EditRequest =
        serde_json::from_slice(body).map_err(|e| format!("bad request body: {e}"))?;
    let root = live.root.as_deref().ok_or("열린 워크스페이스가 없습니다")?;
    if root.starts_with("ssh://") {
        return Err("원격(SSH) 워크스페이스는 아직 쓰기를 지원하지 않습니다".to_string());
    }
    let backend = LocalBackend;
    let root_path = Path::new(root);
    // 새 파일(생성)도 허용하되 루트 내부로 제한.
    let resolved = backend
        .ensure_writable_within(root_path, Path::new(&req.path))
        .map_err(|e| e.to_string())?;
    let _guard = EDIT_LOCK
        .lock()
        .map_err(|_| "edit lock poisoned".to_string())?;
    // 파일이 없으면(에이전트가 새 노트를 만드는 경우) 빈 문자열이 현재 디스크
    // 상태다 — merge_agent_edit이 base와 비교해 알아서 처리한다.
    let disk = backend.read_to_string(&resolved).unwrap_or_default();
    let merged = merge_agent_edit(&req.base_content, &disk, &req.new_content);
    backend
        .write_atomic(&resolved, merged.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(merged)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "OK",
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason(status),
        content_type,
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;
    // 클라이언트가 보내다 만 바이트를 흘려보내 RST를 피한다(베스트 에포트).
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(50)));
    let mut sink = [0u8; 256];
    let _ = stream.read(&mut sink);
    Ok(())
}
