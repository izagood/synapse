//! GitHub 로그인 글루: Device Flow 진행 상태 + OS 키체인 토큰 보관 (FR-4.1, NFR-4)

use std::sync::Mutex;

use serde::Serialize;
use synapse_core::github::{self, Credentials, DeviceCode, PollOutcome, UreqHttp};

/// GitHub OAuth App의 client_id.
/// 배포 빌드는 `SYNAPSE_GITHUB_CLIENT_ID` 환경변수로 주입해 빌드한다.
/// (GitHub → Settings → Developer settings → OAuth Apps, Device Flow 활성화 필요)
const CLIENT_ID: &str = match option_env!("SYNAPSE_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "",
};

const KEYRING_SERVICE: &str = "dev.synapse.app";

/// 토큰+로그인명을 JSON으로 묶어 담는 단일 키체인 항목.
/// macOS는 항목마다 접근 허용을 따로 묻기 때문에 항목을 하나만 쓴다.
const ENTRY_GITHUB: &str = "github";
/// 구버전이 쓰던 항목들 — 발견하면 통합 항목으로 옮기고 지운다.
const LEGACY_ENTRIES: [&str; 2] = ["github-token", "github-login"];
/// Anthropic API 키(2-D). settings.json 평문 대신 OS 키체인에 보관한다.
const ENTRY_AGENT_API_KEY: &str = "agent-api-key";

#[derive(Default)]
pub struct AuthState {
    pub pending_device_code: Mutex<Option<String>>,
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| e.to_string())
}

fn store_credentials(creds: &Credentials) -> Result<(), String> {
    entry(ENTRY_GITHUB)?.set_password(&creds.to_json()).map_err(|e| e.to_string())
}

fn stored_credentials() -> Option<Credentials> {
    if let Ok(json) = entry(ENTRY_GITHUB).ok()?.get_password() {
        return Credentials::from_json(&json).ok();
    }
    // 구버전(항목 2개) 마이그레이션 — 옛 항목은 여기서 마지막으로 읽고 지운다
    let token = entry(LEGACY_ENTRIES[0]).ok()?.get_password().ok()?;
    let login = entry(LEGACY_ENTRIES[1])
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();
    let creds = Credentials { token, login };
    if store_credentials(&creds).is_ok() {
        for name in LEGACY_ENTRIES {
            if let Ok(e) = entry(name) {
                let _ = e.delete_credential();
            }
        }
    }
    Some(creds)
}

pub fn stored_token() -> Option<String> {
    stored_credentials().map(|c| c.token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PollResult {
    Pending,
    SlowDown,
    Ok { login: String },
    Failed { message: String },
}

#[tauri::command]
pub async fn github_login_start(
    state: tauri::State<'_, AuthState>,
) -> Result<DeviceCode, String> {
    if CLIENT_ID.is_empty() {
        return Err(
            "GitHub OAuth client_id가 설정되지 않았습니다. SYNAPSE_GITHUB_CLIENT_ID로 빌드하세요."
                .to_string(),
        );
    }
    // 네트워크 호출은 메인 스레드 밖에서 — 커맨드가 메인 스레드를 점유하면
    // 응답이 올 때까지 앱 UI가 멈춘다 (sync.rs 참고)
    let code =
        crate::sync::run_blocking(|| github::start_device_flow(&UreqHttp, CLIENT_ID)).await?;
    *state.pending_device_code.lock().unwrap() = Some(code.device_code.clone());
    Ok(code)
}

#[tauri::command]
pub async fn github_login_poll(
    state: tauri::State<'_, AuthState>,
) -> Result<PollResult, String> {
    let device_code = state
        .pending_device_code
        .lock()
        .unwrap()
        .clone()
        .ok_or("진행 중인 로그인이 없습니다")?;
    let outcome = crate::sync::run_blocking(move || {
        github::poll_device_flow(&UreqHttp, CLIENT_ID, &device_code)
    })
    .await?;
    match outcome {
        PollOutcome::Pending => Ok(PollResult::Pending),
        PollOutcome::SlowDown => Ok(PollResult::SlowDown),
        PollOutcome::Failed(message) => {
            *state.pending_device_code.lock().unwrap() = None;
            Ok(PollResult::Failed { message })
        }
        PollOutcome::Token(token) => {
            *state.pending_device_code.lock().unwrap() = None;
            let login = crate::sync::run_blocking(move || {
                let login = github::get_login(&UreqHttp, &token)?;
                store_credentials(&Credentials { token, login: login.clone() })?;
                Ok(login)
            })
            .await?;
            Ok(PollResult::Ok { login })
        }
    }
}

#[tauri::command]
pub fn github_user() -> Option<String> {
    let creds = stored_credentials()?;
    if creds.login.is_empty() { None } else { Some(creds.login) }
}

#[tauri::command]
pub fn github_logout() -> Result<(), String> {
    for name in std::iter::once(ENTRY_GITHUB).chain(LEGACY_ENTRIES) {
        if let Ok(e) = entry(name) {
            let _ = e.delete_credential();
        }
    }
    Ok(())
}

// ---- Anthropic API 키 (2-D, github 토큰과 같은 키체인 패턴) ----

/// 키체인에서 Anthropic API 키를 읽는다. 없으면 None.
/// agent.rs가 apiKey 모드에서 ANTHROPIC_API_KEY 주입에 쓴다.
pub fn stored_agent_api_key() -> Option<String> {
    let key = entry(ENTRY_AGENT_API_KEY).ok()?.get_password().ok()?;
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

#[tauri::command]
pub fn set_agent_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API 키가 비어 있습니다".into());
    }
    entry(ENTRY_AGENT_API_KEY)?
        .set_password(key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_agent_api_key() -> Result<(), String> {
    if let Ok(e) = entry(ENTRY_AGENT_API_KEY) {
        // 항목이 없을 때의 NoEntry 오류는 성공으로 간주한다(idempotent).
        let _ = e.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub fn has_agent_api_key() -> bool {
    stored_agent_api_key().is_some()
}
