//! 동기화 커맨드 글루 (FR-4.2 ~ FR-4.5)

use std::path::Path;

use synapse_core::github::{self, UreqHttp};
use synapse_core::{ConflictChoice, GitWorkspace, SyncStatus};

use crate::auth::stored_token;

fn workspace(root: &str) -> GitWorkspace {
    let auth = stored_token().map(|t| GitWorkspace::auth_header_for_token(&t));
    GitWorkspace::new(root, auth)
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
    workspace(&root).sync(message)
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
