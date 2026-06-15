//! 원격 SSH 워크스페이스의 세션 관리와 백엔드 디스패치 (Tauri 셸 측).
//!
//! 실제 SSH/SFTP 로직은 synapse-core(`ssh`/`sftp`)에 있다. 여기서는 활성 세션을
//! 호스트 단위로 보관하고, 커맨드가 받은 위치 문자열(로컬 경로 또는 `ssh://` URI)을
//! 적절한 [`Backend`]로 연결한다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use synapse_core::{
    Backend, HostKeyPolicy, LocalBackend, Location, SftpBackend, SshConfig, SshError, SshLocation,
    SshSession,
};

/// 활성 SSH 세션 레지스트리 (Tauri managed state).
/// 키는 `user@host:port` — 같은 호스트의 여러 폴더가 한 연결을 공유한다.
#[derive(Default)]
pub struct RemoteState {
    sessions: Mutex<HashMap<String, Arc<SshSession>>>,
}

fn session_key(loc: &SshLocation) -> String {
    format!("{}@{}:{}", loc.user, loc.host, loc.port)
}

impl RemoteState {
    fn get(&self, loc: &SshLocation) -> Option<Arc<SshSession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&session_key(loc))
            .cloned()
    }

    fn put(&self, session: Arc<SshSession>) {
        let key = session_key(session.location());
        self.sessions.lock().unwrap().insert(key, session);
    }

    fn remove(&self, loc: &SshLocation) {
        self.sessions.lock().unwrap().remove(&session_key(loc));
    }
}

/// 위치에 맞는 파일시스템 백엔드. 원격이면 연결된 세션이 있어야 한다.
pub fn backend_for(state: &RemoteState, loc: &Location) -> Result<Arc<dyn Backend>, String> {
    match loc {
        Location::Local(_) => Ok(Arc::new(LocalBackend) as Arc<dyn Backend>),
        Location::Ssh(s) => match state.get(s) {
            Some(session) => Ok(Arc::new(SftpBackend::new(session)) as Arc<dyn Backend>),
            None => Err("원격 세션이 연결되어 있지 않습니다. 먼저 연결하세요.".to_string()),
        },
    }
}

/// 위치에 연결된 SSH 세션을 돌려준다(로컬이면 None, 원격인데 미연결이면 에러).
/// git/협업 커맨드가 run_blocking 진입 전에 세션을 꺼내 쓰기 위한 헬퍼다.
pub fn remote_session(
    state: &RemoteState,
    loc: &Location,
) -> Result<Option<Arc<SshSession>>, String> {
    match loc {
        Location::Local(_) => Ok(None),
        Location::Ssh(s) => state
            .get(s)
            .map(Some)
            .ok_or_else(|| "원격 세션이 연결되어 있지 않습니다. 먼저 연결하세요.".to_string()),
    }
}

/// 위치 식별자에서 백엔드에 넘길 bare 파일시스템 경로를 뽑는다.
pub fn fs_path(loc: &Location) -> PathBuf {
    match loc {
        Location::Local(p) => p.clone(),
        Location::Ssh(s) => PathBuf::from(&s.path),
    }
}

/// 원격 위치는 거부한다(아직 로컬만 지원하는 기능용 가드: 협업/git/검색 등).
pub fn require_local(loc: &Location) -> Result<(), String> {
    if loc.is_remote() {
        Err("이 기능은 아직 원격 워크스페이스에서 지원되지 않습니다.".to_string())
    } else {
        Ok(())
    }
}

#[derive(Serialize)]
pub struct RemoteConnection {
    /// 절대경로로 해소된 워크스페이스 루트 URI(빈 경로는 원격 홈으로 해소됨).
    pub root: String,
}

/// 원격 호스트에 연결·인증하고 세션을 등록한다.
///
/// 호스트키가 known_hosts에 없으면(미등록) `accept_new_host_key`가 false일 때
/// `UNKNOWN_HOST_KEY:<fingerprint>` 오류를 돌려준다 — 프론트는 fingerprint를
/// 보여 사용자 승인을 받은 뒤 true로 다시 호출한다. 키 불일치는
/// `HOST_KEY_MISMATCH:<fingerprint>`(항상 거부).
#[tauri::command]
pub async fn connect_remote(
    state: tauri::State<'_, RemoteState>,
    uri: String,
    key_path: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
    accept_new_host_key: bool,
) -> Result<RemoteConnection, String> {
    let loc = Location::parse(&uri).map_err(|e| e.to_string())?;
    let ssh_loc = match loc {
        Location::Ssh(s) => s,
        Location::Local(_) => return Err("ssh:// URI가 아닙니다".to_string()),
    };

    let home = dirs::home_dir().ok_or("홈 디렉토리를 찾을 수 없습니다")?;
    let mut cfg = SshConfig::with_defaults(&home);
    // 사용자가 키 파일을 직접 지정하면 가장 먼저 시도한다(~/.ssh 기본 키보다 우선).
    // GUI에 흔히 입력하는 `~/.ssh/...` 틸드 경로를 홈으로 확장한다 — 확장하지 않으면
    // `Path::exists()`가 false가 돼 해당 키가 조용히 스킵되고 인증이 실패한다.
    if let Some(key) = key_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        cfg.identity_files
            .insert(0, synapse_core::expand_tilde(&key, &home));
    }
    cfg.password = password;
    cfg.passphrase = passphrase;
    cfg.host_key_policy = if accept_new_host_key {
        HostKeyPolicy::AcceptNew
    } else {
        HostKeyPolicy::Strict
    };

    let connect_loc = ssh_loc.clone();
    let (session, resolved_uri) = crate::sync::run_blocking(move || {
        let session = synapse_core::ssh_connect(&connect_loc, &cfg).map_err(|e| match e {
            SshError::UnknownHostKey { fingerprint } => format!("UNKNOWN_HOST_KEY:{fingerprint}"),
            SshError::HostKeyMismatch { fingerprint } => format!("HOST_KEY_MISMATCH:{fingerprint}"),
            other => other.to_string(),
        })?;
        // 경로가 비어 있으면(ssh://user@host) 원격 홈을 realpath로 해소한다.
        let mut resolved = session.location().clone();
        if resolved.path.is_empty() {
            let backend = SftpBackend::new(session.clone());
            let home_path = backend
                .canonicalize(Path::new("."))
                .map_err(|e| e.to_string())?;
            resolved.path = home_path.to_string_lossy().into_owned();
        }
        Ok((session, Location::Ssh(resolved).to_uri()))
    })
    .await?;

    state.put(session);
    Ok(RemoteConnection { root: resolved_uri })
}

/// 원격 세션을 끊는다(같은 호스트의 모든 폴더 공유 연결 종료).
#[tauri::command]
pub fn disconnect_remote(state: tauri::State<'_, RemoteState>, uri: String) -> Result<(), String> {
    if let Ok(Location::Ssh(s)) = Location::parse(&uri) {
        state.remove(&s);
    }
    Ok(())
}
