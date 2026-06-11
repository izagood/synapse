//! GitHub 기반 설정 동기화의 기기-로컬 연동 상태 (1-E).
//!
//! 개인 config 레포를 연결해두면 기기를 바꿔도 GitHub 로그인 + 레포 이름만으로
//! settings.json이 따라온다 — DB 없이 클라우드 DB 같은 경험.
//!
//! 핵심 설계:
//! - 동기화하는 것은 `settings.json`뿐이다(기기 독립적).
//! - `workspaces.json`은 절대 경로 키라 기기마다 다르므로 **동기화하지 않는다**
//!   (기존 config_dir에 그대로 남는다).
//! - config 레포는 `config_dir/cloud/`에 git 작업트리로 clone하고, 연동되면
//!   settings 읽기/쓰기를 그쪽으로 향하게 한다.
//! - 연동 여부 자체(어떤 레포에 연결됐는지)는 기기-로컬 정보이므로 동기화 레포가
//!   아니라 `config_dir/config-sync.json`에 둔다.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "config-sync.json";
const CLOUD_SUBDIR: &str = "cloud";
/// settings.rs의 SETTINGS_FILE과 같아야 한다.
const SETTINGS_FILE: &str = "settings.json";

/// 이 기기에서의 설정 동기화 연동 상태 (동기화 대상 아님).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigSyncState {
    pub linked: bool,
    /// "owner/repo" 형식.
    pub repo_name: Option<String>,
}

pub fn load_state(config_dir: &Path) -> ConfigSyncState {
    match std::fs::read_to_string(config_dir.join(STATE_FILE)) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => ConfigSyncState::default(),
    }
}

pub fn save_state(config_dir: &Path, state: &ConfigSyncState) -> io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let text = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    crate::fs_io::atomic_write(&config_dir.join(STATE_FILE), &text)
}

/// 설정 동기화용 클라우드 작업트리 경로 (config_dir/cloud).
pub fn cloud_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(CLOUD_SUBDIR)
}

/// settings.json을 읽고 쓸 디렉토리를 고른다.
///
/// 연동되어 있고 클라우드 작업트리에 settings.json이 있으면 그쪽, 아니면 기존
/// config_dir. (workspaces.json·actor id 등 기기-로컬 상태는 항상 config_dir.)
pub fn settings_dir(config_dir: &Path) -> PathBuf {
    let state = load_state(config_dir);
    let cloud = cloud_dir(config_dir);
    if state.linked && cloud.join(SETTINGS_FILE).exists() {
        cloud
    } else {
        config_dir.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn defaults_to_unlinked_when_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_state(dir.path()), ConfigSyncState::default());
        assert!(!load_state(dir.path()).linked);
        fs::write(dir.path().join(STATE_FILE), "{ broken").unwrap();
        assert_eq!(load_state(dir.path()), ConfigSyncState::default());
    }

    #[test]
    fn roundtrips_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = ConfigSyncState {
            linked: true,
            repo_name: Some("me/synapse-config".into()),
        };
        save_state(dir.path(), &state).unwrap();
        assert_eq!(load_state(dir.path()), state);
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_string(&ConfigSyncState {
            linked: true,
            repo_name: Some("a/b".into()),
        })
        .unwrap();
        assert!(json.contains("\"repoName\""));
    }

    #[test]
    fn settings_dir_is_local_when_unlinked() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(settings_dir(dir.path()), dir.path().to_path_buf());
    }

    #[test]
    fn settings_dir_is_cloud_when_linked_and_present() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = cloud_dir(dir.path());
        fs::create_dir_all(&cloud).unwrap();
        fs::write(cloud.join(SETTINGS_FILE), "{}").unwrap();
        save_state(
            dir.path(),
            &ConfigSyncState {
                linked: true,
                repo_name: Some("a/b".into()),
            },
        )
        .unwrap();
        assert_eq!(settings_dir(dir.path()), cloud);
    }

    #[test]
    fn settings_dir_falls_back_when_linked_but_cloud_missing() {
        let dir = tempfile::tempdir().unwrap();
        save_state(
            dir.path(),
            &ConfigSyncState {
                linked: true,
                repo_name: Some("a/b".into()),
            },
        )
        .unwrap();
        // 클라우드 작업트리가 아직 없으면 로컬로 폴백 (앱이 깨지지 않게)
        assert_eq!(settings_dir(dir.path()), dir.path().to_path_buf());
    }
}
