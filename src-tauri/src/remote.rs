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
    /// 연결 시 사용자가 지정한 키 경로(세션 키 → 틸드 확장 완료 경로).
    /// 내장/외부 터미널이 시스템 ssh를 띄울 때 `-i`로 재사용한다.
    key_paths: Mutex<HashMap<String, String>>,
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
        self.key_paths.lock().unwrap().remove(&session_key(loc));
    }

    /// 연결에 쓰인 키 경로를 기록한다(None이면 기존 기록 제거).
    pub fn record_key_path(&self, loc: &SshLocation, key: Option<String>) {
        let mut map = self.key_paths.lock().unwrap();
        match key {
            Some(k) => {
                map.insert(session_key(loc), k);
            }
            None => {
                map.remove(&session_key(loc));
            }
        }
    }

    /// 이 위치의 연결에 쓰인 키 경로(터미널 ssh 재사용용).
    pub fn key_path_for(&self, loc: &SshLocation) -> Option<String> {
        self.key_paths
            .lock()
            .unwrap()
            .get(&session_key(loc))
            .cloned()
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
    let mut stored_key: Option<String> = None;
    if let Some(key) = key_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        let expanded = synapse_core::expand_tilde(&key, &home);
        stored_key = Some(expanded.to_string_lossy().into_owned());
        cfg.identity_files.insert(0, expanded);
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
    state.record_key_path(&ssh_loc, stored_key);
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

/// `ssh ...` 명령어 파싱 결과(접속에 바로 쓸 수 있게 해소한 형태).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedRemoteTarget {
    /// `ssh://user@host[:port]` — 경로는 비워 둔다(연결 후 홈으로 해소).
    pub uri: String,
    /// `-i`/IdentityFile 로 지정된 키 경로(틸드 미확장, 없으면 None).
    pub key_path: Option<String>,
}

/// 사용자가 붙여넣은 `ssh ...` 한 줄을 접속 대상으로 해소한다.
///
/// `~/.ssh/config` 의 Host 별칭(HostName/User/Port/IdentityFile)을 읽어 병합한다.
/// 병합 우선순위는 ssh와 동일하게 **명령줄 옵션 > config > 기본값**이며,
/// user 미지정 시 로컬 사용자(`$USER`/`$USERNAME`), port 기본값은 22다.
/// 인증(에이전트/키/비밀번호)과 실제 연결은 [`connect_remote`]가 맡는다.
#[tauri::command]
pub fn parse_ssh_command(command: String) -> Result<ParsedRemoteTarget, String> {
    let inv = synapse_core::parse_ssh_command(&command).map_err(|e| e.to_string())?;

    // ~/.ssh/config 가 있으면 읽어 별칭을 해소한다(없으면 빈 설정으로 진행).
    let cfg_text = dirs::home_dir()
        .map(|h| h.join(".ssh").join("config"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let hc = synapse_core::resolve_host(&inv.host, &cfg_text);

    let host = inv
        .host_name
        .clone()
        .or(hc.host_name)
        .unwrap_or_else(|| inv.host.clone());
    let port = inv
        .port
        .or(hc.port)
        .unwrap_or(synapse_core::DEFAULT_SSH_PORT);
    let user = inv
        .user
        .clone()
        .or(hc.user)
        .or_else(default_local_user)
        .ok_or("사용자를 알 수 없습니다. user@host 형태로 입력하세요.")?;
    let key_path = inv.identity_file.clone().or(hc.identity_file);

    let loc = SshLocation {
        user,
        host,
        port,
        path: String::new(),
    };
    Ok(ParsedRemoteTarget {
        uri: Location::Ssh(loc).to_uri(),
        key_path,
    })
}

/// 로그인한 OS 사용자명(이름을 명령줄·config 어디에도 안 줬을 때의 마지막 기본값).
fn default_local_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|s| !s.is_empty())
}

/// 원격 디렉토리 한 단계의 항목들(이름 + 디렉토리 여부). 디렉토리 브라우저용.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// 연결된 원격 세션에서 `uri` 가 가리키는 디렉토리의 바로 아래 항목을 나열한다.
/// 디렉토리를 앞으로, 그 안에서 이름순(대소문자 무시)으로 정렬한다.
#[tauri::command]
pub async fn list_remote_dir(
    state: tauri::State<'_, RemoteState>,
    uri: String,
) -> Result<Vec<RemoteDirEntry>, String> {
    let loc = Location::parse(&uri).map_err(|e| e.to_string())?;
    let backend = backend_for(&state, &loc)?;
    let dir = fs_path(&loc);
    crate::sync::run_blocking(move || {
        let entries = backend.read_dir(&dir).map_err(|e| e.to_string())?;
        let mut out: Vec<RemoteDirEntry> = entries
            .into_iter()
            .map(|e| {
                // 심링크 대상까지 따라가 디렉토리 여부를 본다(따라가다 실패하면 파일 취급).
                let is_dir = backend.metadata(&e.path).map(|m| m.is_dir).unwrap_or(false);
                RemoteDirEntry {
                    name: e.name,
                    is_dir,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // 프론트(src/ipc/types.ts)는 camelCase 필드를 읽는다. Tauri는 커맨드 "인자"만
    // camelCase↔snake_case 를 자동 변환하고 "반환값"은 serde 직렬화 그대로이므로,
    // rename 누락 시 isDir/keyPath 가 조용히 undefined 가 된다 (#115 회귀 방지).
    #[test]
    fn remote_dir_entry_serializes_camel_case_for_frontend() {
        let entry = RemoteDirEntry {
            name: "docs".into(),
            is_dir: true,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({ "name": "docs", "isDir": true })
        );
    }

    #[test]
    fn parsed_remote_target_serializes_camel_case_for_frontend() {
        let target = ParsedRemoteTarget {
            uri: "ssh://me@host".into(),
            key_path: Some("~/.ssh/id_ed25519".into()),
        };
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            serde_json::json!({ "uri": "ssh://me@host", "keyPath": "~/.ssh/id_ed25519" })
        );
    }

    #[test]
    fn remote_state_records_and_clears_key_path() {
        let loc = SshLocation {
            user: "me".into(),
            host: "h".into(),
            port: 22,
            path: "/ws".into(),
        };
        let state = RemoteState::default();
        assert_eq!(state.key_path_for(&loc), None);

        state.record_key_path(&loc, Some("/home/me/.ssh/k".into()));
        assert_eq!(state.key_path_for(&loc), Some("/home/me/.ssh/k".into()));

        // None 기록은 기존 값을 지운다(키 없이 재연결한 경우).
        state.record_key_path(&loc, None);
        assert_eq!(state.key_path_for(&loc), None);
    }
}
