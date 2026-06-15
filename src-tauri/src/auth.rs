//! GitHub 로그인 글루: Device Flow 진행 상태 + 토큰 보관 (FR-4.1, NFR-4)
//!
//! 토큰·API 키는 권한 0600 파일(`secrets.json`)에 보관한다. 셀프사인 서명
//! 빌드에서 OS 키체인은 업데이트마다 "항상 허용"을 다시 묻기 때문이다
//! (자세한 배경은 `synapse_core::secrets` 참고). 구버전이 키체인에 저장한
//! 값은 최초 1회 파일로 옮기고 키체인 항목을 지운다.

use std::path::PathBuf;
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

/// 구버전 키체인 항목을 찾을 때 쓰는 서비스 이름 (마이그레이션 전용).
const KEYRING_SERVICE: &str = "dev.synapse.app";

/// 토큰+로그인명을 JSON으로 묶어 담는 단일 항목.
const ENTRY_GITHUB: &str = "github";
/// 더 옛날(키체인 항목 2개) 포맷 — 발견하면 통합 항목으로 옮기고 지운다.
const LEGACY_ENTRIES: [&str; 2] = ["github-token", "github-login"];
/// Anthropic API 키(2-D). settings.json 평문 대신 0600 파일에 보관한다.
const ENTRY_AGENT_API_KEY: &str = "agent-api-key";

#[derive(Default)]
pub struct AuthState {
    pub pending_device_code: Mutex<Option<String>>,
}

/// 비밀 파일 경로: ~/.config/synapse/secrets.json
fn secrets_path() -> Result<PathBuf, String> {
    Ok(crate::commands::config_dir()?.join("secrets.json"))
}

/// 구버전 OS 키체인 항목 핸들 (마이그레이션·정리 전용).
fn keychain_entry(name: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, name).ok()
}

fn store_credentials(creds: &Credentials) -> Result<(), String> {
    let path = secrets_path()?;
    synapse_core::secrets::write_secret(&path, ENTRY_GITHUB, &creds.to_json())
        .map_err(|e| e.to_string())
}

fn stored_credentials() -> Option<Credentials> {
    let path = secrets_path().ok()?;
    if let Some(json) = synapse_core::secrets::read_secret(&path, ENTRY_GITHUB) {
        return Credentials::from_json(&json).ok();
    }
    // 파일에 없으면 구버전 OS 키체인에서 한 번만 옮겨온다.
    migrate_github_from_keychain(&path)
}

/// 기존 키체인에 저장돼 있던 GitHub 자격증명을 파일로 옮긴다 (1회성).
/// 통합 항목을 먼저 보고, 없으면 더 옛날 2-항목 포맷을 본다. 옮긴 뒤
/// 키체인 잔재는 best-effort로 지운다.
fn migrate_github_from_keychain(path: &std::path::Path) -> Option<Credentials> {
    let creds = match keychain_entry(ENTRY_GITHUB).and_then(|e| e.get_password().ok()) {
        Some(json) => Credentials::from_json(&json).ok()?,
        None => {
            let token = keychain_entry(LEGACY_ENTRIES[0])?.get_password().ok()?;
            let login = keychain_entry(LEGACY_ENTRIES[1])
                .and_then(|e| e.get_password().ok())
                .unwrap_or_default();
            Credentials { token, login }
        }
    };
    let _ = synapse_core::secrets::write_secret(path, ENTRY_GITHUB, &creds.to_json());
    for name in std::iter::once(ENTRY_GITHUB).chain(LEGACY_ENTRIES) {
        if let Some(e) = keychain_entry(name) {
            let _ = e.delete_credential();
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
pub async fn github_login_start(state: tauri::State<'_, AuthState>) -> Result<DeviceCode, String> {
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
pub async fn github_login_poll(state: tauri::State<'_, AuthState>) -> Result<PollResult, String> {
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
                store_credentials(&Credentials {
                    token,
                    login: login.clone(),
                })?;
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
    if creds.login.is_empty() {
        None
    } else {
        Some(creds.login)
    }
}

#[tauri::command]
pub fn github_logout() -> Result<(), String> {
    if let Ok(path) = secrets_path() {
        let _ = synapse_core::secrets::delete_secret(&path, ENTRY_GITHUB);
    }
    // 구버전 키체인 잔재도 함께 정리한다.
    for name in std::iter::once(ENTRY_GITHUB).chain(LEGACY_ENTRIES) {
        if let Some(e) = keychain_entry(name) {
            let _ = e.delete_credential();
        }
    }
    Ok(())
}

// ---- Anthropic API 키 (2-D, github 토큰과 같은 파일 패턴) ----

/// 저장된 Anthropic API 키를 읽는다. 없으면 None.
/// agent.rs가 apiKey 모드에서 ANTHROPIC_API_KEY 주입에 쓴다.
pub fn stored_agent_api_key() -> Option<String> {
    let path = secrets_path().ok()?;
    if let Some(key) = synapse_core::secrets::read_secret(&path, ENTRY_AGENT_API_KEY) {
        return Some(key);
    }
    // 파일에 없으면 구버전 키체인에서 한 번만 옮겨온다.
    let key = keychain_entry(ENTRY_AGENT_API_KEY)?.get_password().ok()?;
    if key.is_empty() {
        return None;
    }
    let _ = synapse_core::secrets::write_secret(&path, ENTRY_AGENT_API_KEY, &key);
    if let Some(e) = keychain_entry(ENTRY_AGENT_API_KEY) {
        let _ = e.delete_credential();
    }
    Some(key)
}

#[tauri::command]
pub fn set_agent_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API 키가 비어 있습니다".into());
    }
    let path = secrets_path()?;
    synapse_core::secrets::write_secret(&path, ENTRY_AGENT_API_KEY, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_agent_api_key() -> Result<(), String> {
    if let Ok(path) = secrets_path() {
        let _ = synapse_core::secrets::delete_secret(&path, ENTRY_AGENT_API_KEY);
    }
    // 구버전 키체인 잔재도 정리한다 (idempotent).
    if let Some(e) = keychain_entry(ENTRY_AGENT_API_KEY) {
        let _ = e.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub fn has_agent_api_key() -> bool {
    stored_agent_api_key().is_some()
}
