//! 설정 동기화 커맨드 (1-E): 개인 config 레포를 연결해 settings.json을 기기 간
//! 공유한다. 노트 동기화(sync.rs)와 같은 git/GitHub 인프라를 그대로 재사용한다.
//!
//! - 동기화 대상은 settings.json뿐. workspaces.json은 기기-로컬이라 제외된다.
//! - config 레포는 `~/.config/synapse/cloud/`에 git 작업트리로 둔다.
//! - 연결 여부는 기기-로컬 정보라 동기화 레포가 아닌 `config-sync.json`에 저장.

use serde::Serialize;
use synapse_core::config_sync::{self, ConfigSyncState};
use synapse_core::github::{self, UreqHttp};
use synapse_core::{settings, GitWorkspace, SyncStatus};

use crate::auth::stored_token;
use crate::commands::config_dir;
use crate::sync::run_blocking;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncStatus {
    linked: bool,
    repo_name: Option<String>,
    /// 연결돼 있을 때 클라우드 작업트리의 git 상태(없으면 null).
    sync: Option<SyncStatus>,
}

fn auth_header() -> Option<String> {
    stored_token().map(|t| GitWorkspace::auth_header_for_token(&t))
}

fn status_for(state: &ConfigSyncState) -> ConfigSyncStatus {
    let sync = if state.linked {
        config_dir()
            .ok()
            .map(|cfg| GitWorkspace::new(config_sync::cloud_dir(&cfg), auth_header()).status())
    } else {
        None
    };
    ConfigSyncStatus {
        linked: state.linked,
        repo_name: state.repo_name.clone(),
        sync,
    }
}

#[tauri::command]
pub async fn config_sync_status() -> Result<ConfigSyncStatus, String> {
    run_blocking(move || {
        let cfg = config_dir()?;
        Ok(status_for(&config_sync::load_state(&cfg)))
    })
    .await
}

/// 개인 config 레포를 연결한다.
/// - `name`: "owner/repo" 또는 "repo"(이 경우 로그인 사용자를 owner로).
/// - `create`: true면 새 private 레포를 만들어 현재 설정을 첫 게시, false면 기존 레포 clone.
#[tauri::command]
pub async fn link_config_repo(name: String, create: bool) -> Result<ConfigSyncStatus, String> {
    run_blocking(move || {
        let token = stored_token().ok_or("GitHub 로그인이 필요합니다")?;
        let cfg = config_dir()?;
        let cloud = config_sync::cloud_dir(&cfg);
        if cloud.exists() {
            return Err("이미 연결된 설정 저장소가 있습니다. 먼저 연결을 해제하세요.".to_string());
        }

        // owner/repo 정규화
        let (owner, repo) = match name.split_once('/') {
            Some((o, r)) => (o.trim().to_string(), r.trim().to_string()),
            None => (
                github::get_login(&UreqHttp, &token)?,
                name.trim().to_string(),
            ),
        };
        if repo.is_empty() || repo.contains("..") || repo.contains('/') {
            return Err("레포 이름이 올바르지 않습니다".to_string());
        }
        let full = format!("{owner}/{repo}");

        if create {
            let created = github::create_repo(&UreqHttp, &token, &repo, true)?;
            std::fs::create_dir_all(&cloud).map_err(|e| e.to_string())?;
            // 현재(로컬) 설정을 클라우드 작업트리에 담아 첫 push 한다
            let current = settings::load_settings(&cfg);
            settings::save_settings(&cloud, &current).map_err(|e| e.to_string())?;
            GitWorkspace::new(&cloud, auth_header())
                .publish(&created.clone_url, "synapse: 설정 초기 게시")?;
        } else {
            let url = format!("https://github.com/{owner}/{repo}.git");
            GitWorkspace::clone(&url, &cloud, auth_header())?;
            // 레포에 설정이 아직 없으면 현재 로컬 설정을 올린다
            if !cloud.join(settings::SETTINGS_FILE).exists() {
                let current = settings::load_settings(&cfg);
                settings::save_settings(&cloud, &current).map_err(|e| e.to_string())?;
                let _ = GitWorkspace::new(&cloud, auth_header()).sync("synapse: 설정 초기화");
            }
        }

        let state = ConfigSyncState {
            linked: true,
            repo_name: Some(full),
        };
        config_sync::save_state(&cfg, &state).map_err(|e| e.to_string())?;
        Ok(status_for(&state))
    })
    .await
}

/// 연결을 해제한다. `keep_local`이면 클라우드 설정을 로컬로 복사해 보존한다.
#[tauri::command]
pub async fn unlink_config_repo(keep_local: bool) -> Result<ConfigSyncStatus, String> {
    run_blocking(move || {
        let cfg = config_dir()?;
        let cloud = config_sync::cloud_dir(&cfg);
        if keep_local && cloud.join(settings::SETTINGS_FILE).exists() {
            let s = settings::load_settings(&cloud);
            settings::save_settings(&cfg, &s).map_err(|e| e.to_string())?;
        }
        if cloud.exists() {
            std::fs::remove_dir_all(&cloud).map_err(|e| e.to_string())?;
        }
        let state = ConfigSyncState::default();
        config_sync::save_state(&cfg, &state).map_err(|e| e.to_string())?;
        Ok(status_for(&state))
    })
    .await
}

/// 설정을 지금 push/pull 한다 (수동 동기화 · 설정 화면 닫을 때).
#[tauri::command]
pub async fn config_sync_now() -> Result<ConfigSyncStatus, String> {
    run_blocking(move || {
        let cfg = config_dir()?;
        let state = config_sync::load_state(&cfg);
        if !state.linked {
            return Err("연결된 설정 저장소가 없습니다".to_string());
        }
        let cloud = config_sync::cloud_dir(&cfg);
        GitWorkspace::new(&cloud, auth_header()).sync("synapse: 설정 동기화")?;
        Ok(status_for(&state))
    })
    .await
}
