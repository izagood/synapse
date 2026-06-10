//! GitHub 로그인 글루: Device Flow 진행 상태 + OS 키체인 토큰 보관 (FR-4.1, NFR-4)

use std::sync::Mutex;

use serde::Serialize;
use synapse_core::github::{self, DeviceCode, PollOutcome, UreqHttp};

/// GitHub OAuth App의 client_id.
/// 배포 빌드는 `SYNAPSE_GITHUB_CLIENT_ID` 환경변수로 주입해 빌드한다.
/// (GitHub → Settings → Developer settings → OAuth Apps, Device Flow 활성화 필요)
const CLIENT_ID: &str = match option_env!("SYNAPSE_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "",
};

const KEYRING_SERVICE: &str = "dev.synapse.app";

#[derive(Default)]
pub struct AuthState {
    pub pending_device_code: Mutex<Option<String>>,
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| e.to_string())
}

pub fn stored_token() -> Option<String> {
    entry("github-token").ok()?.get_password().ok()
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
pub fn github_login_start(state: tauri::State<AuthState>) -> Result<DeviceCode, String> {
    if CLIENT_ID.is_empty() {
        return Err(
            "GitHub OAuth client_id가 설정되지 않았습니다. SYNAPSE_GITHUB_CLIENT_ID로 빌드하세요."
                .to_string(),
        );
    }
    let code = github::start_device_flow(&UreqHttp, CLIENT_ID)?;
    *state.pending_device_code.lock().unwrap() = Some(code.device_code.clone());
    Ok(code)
}

#[tauri::command]
pub fn github_login_poll(state: tauri::State<AuthState>) -> Result<PollResult, String> {
    let device_code = state
        .pending_device_code
        .lock()
        .unwrap()
        .clone()
        .ok_or("진행 중인 로그인이 없습니다")?;
    match github::poll_device_flow(&UreqHttp, CLIENT_ID, &device_code)? {
        PollOutcome::Pending => Ok(PollResult::Pending),
        PollOutcome::SlowDown => Ok(PollResult::SlowDown),
        PollOutcome::Failed(message) => {
            *state.pending_device_code.lock().unwrap() = None;
            Ok(PollResult::Failed { message })
        }
        PollOutcome::Token(token) => {
            *state.pending_device_code.lock().unwrap() = None;
            let login = github::get_login(&UreqHttp, &token)?;
            entry("github-token")?.set_password(&token).map_err(|e| e.to_string())?;
            entry("github-login")?.set_password(&login).map_err(|e| e.to_string())?;
            Ok(PollResult::Ok { login })
        }
    }
}

#[tauri::command]
pub fn github_user() -> Option<String> {
    stored_token()?;
    entry("github-login").ok()?.get_password().ok()
}

#[tauri::command]
pub fn github_logout() -> Result<(), String> {
    for name in ["github-token", "github-login"] {
        if let Ok(e) = entry(name) {
            let _ = e.delete_credential();
        }
    }
    Ok(())
}
