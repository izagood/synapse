//! 동기화 커맨드 글루 (FR-4.2 ~ FR-4.5)

use std::path::Path;

use synapse_core::github::{self, UreqHttp};
use synapse_core::{collab, CollabStore, ConflictChoice, GitWorkspace, SyncStatus};

use crate::auth::stored_token;

fn workspace(root: &str) -> GitWorkspace {
    let auth = stored_token().map(|t| GitWorkspace::auth_header_for_token(&t));
    GitWorkspace::new(root, auth)
}

/// 이 워크스페이스의 CRDT 저장 계층 (actor id는 설치본 단위)
fn collab_store(root: &str) -> Result<CollabStore, String> {
    let actor = collab::load_or_create_actor_id(&crate::commands::config_dir()?)
        .map_err(|e| e.to_string())?;
    Ok(CollabStore::new(root, actor))
}

#[tauri::command]
pub fn sync_status(root: String) -> SyncStatus {
    workspace(&root).status()
}

#[tauri::command]
pub fn sync_now(root: String, message: String) -> Result<SyncStatus, String> {
    let message = if message.trim().is_empty() {
        "synapse: 노트 동기화"
    } else {
        message.trim()
    };
    // CRDT 충돌 자동 해결 포함. 저장 커맨드와 같은 락으로 직렬화한다.
    let store = collab_store(&root).ok();
    let _guard = collab::workspace_lock()
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    workspace(&root).sync_with_collab(message, store.as_ref())
}

#[tauri::command]
pub fn resolve_conflict(root: String, choice: ConflictChoice) -> Result<SyncStatus, String> {
    workspace(&root).resolve_conflicts(choice)
}

/// GitHub에 리포지토리를 만들고 워크스페이스를 첫 push 한다
#[tauri::command]
pub fn publish_workspace(
    root: String,
    name: String,
    private: bool,
) -> Result<SyncStatus, String> {
    let token = stored_token().ok_or("GitHub 로그인이 필요합니다")?;
    let repo = github::create_repo(&UreqHttp, &token, &name, private)?;
    workspace(&root).publish(&repo.clone_url, "synapse: 초기 게시")
}

/// 원격 리포지토리를 parent_dir/name 폴더로 클론하고 경로를 돌려준다
#[tauri::command]
pub fn clone_repo(url: String, parent_dir: String, name: String) -> Result<String, String> {
    if name.contains('/') || name.contains("..") || name.is_empty() {
        return Err("폴더 이름이 올바르지 않습니다".to_string());
    }
    let dest = Path::new(&parent_dir).join(&name);
    if dest.exists() {
        return Err(format!("이미 존재하는 폴더입니다: {}", dest.display()));
    }
    let auth = stored_token().map(|t| GitWorkspace::auth_header_for_token(&t));
    let path = GitWorkspace::clone(&url, &dest, auth)?;
    Ok(path.display().to_string())
}
