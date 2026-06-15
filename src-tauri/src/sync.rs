//! 동기화 커맨드 글루 (FR-4.2 ~ FR-4.5)
//!
//! 모든 커맨드는 async이고 실제 작업은 `run_blocking`으로 스레드 풀에서
//! 돈다. Tauri의 non-async 커맨드는 메인 스레드에서 실행되므로, git
//! 네트워크 작업을 그대로 돌리면 끝날 때까지 앱 전체 UI가 멈춘다.

use std::path::Path;
use std::sync::Arc;

use synapse_core::github::{self, UreqHttp};
use synapse_core::{
    collab, Backend, CollabStore, ConflictChoice, ConflictPreview, FileCommit, GitWorkspace,
    LocalBackend, Location, SftpBackend, SshSession, SyncStatus,
};

use crate::auth::stored_token;
use crate::remote::{fs_path, remote_session, RemoteState};

/// 블로킹 작업(git 서브프로세스·네트워크·디스크)을 메인 스레드 밖에서 돌린다.
pub(crate) async fn run_blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("백그라운드 작업 실패: {e}"))?
}

/// 위치 문자열을 파싱하고, 연결된 원격 세션(있으면)과 bare 경로를 함께 돌려준다.
/// run_blocking 진입 전에 호출해 세션을 클로저로 옮긴다.
fn resolve(state: &RemoteState, root: &str) -> Result<(Option<Arc<SshSession>>, String), String> {
    let loc = Location::parse(root).map_err(|e| e.to_string())?;
    let session = remote_session(state, &loc)?;
    Ok((session, fs_path(&loc).to_string_lossy().into_owned()))
}

fn build_workspace(session: Option<Arc<SshSession>>, root: &str) -> GitWorkspace {
    match session {
        Some(s) => GitWorkspace::new_remote(s, root),
        None => {
            let auth = stored_token().map(|t| GitWorkspace::auth_header_for_token(&t));
            GitWorkspace::new(root, auth)
        }
    }
}

fn backend_of(session: &Option<Arc<SshSession>>) -> Arc<dyn Backend> {
    match session {
        Some(s) => Arc::new(SftpBackend::new(s.clone())),
        None => Arc::new(LocalBackend),
    }
}

/// 이 워크스페이스의 CRDT 저장 계층 (actor id는 설치본 단위, 로컬 config에서 읽음)
fn build_store(session: Option<Arc<SshSession>>, root: &str) -> Result<CollabStore, String> {
    let actor = collab::load_or_create_actor_id(&crate::commands::config_dir()?)
        .map_err(|e| e.to_string())?;
    Ok(match session {
        Some(s) => CollabStore::new(Arc::new(SftpBackend::new(s)), root.to_string(), actor),
        None => CollabStore::local(root, actor),
    })
}

#[tauri::command]
pub async fn sync_status(
    state: tauri::State<'_, RemoteState>,
    root: String,
) -> Result<SyncStatus, String> {
    let (session, root) = resolve(&state, &root)?;
    run_blocking(move || Ok(build_workspace(session, &root).status())).await
}

#[tauri::command]
pub async fn sync_now(
    state: tauri::State<'_, RemoteState>,
    root: String,
    message: String,
) -> Result<SyncStatus, String> {
    let (session, root) = resolve(&state, &root)?;
    run_blocking(move || {
        let message = if message.trim().is_empty() {
            "synapse: 노트 동기화"
        } else {
            message.trim()
        };
        // CRDT 충돌 자동 해결 포함. 락은 sync 내부에서 로컬 구간에만 잡힌다.
        let store = build_store(session.clone(), &root).ok();
        build_workspace(session, &root).sync_with_collab(message, store.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn resolve_conflict(
    state: tauri::State<'_, RemoteState>,
    root: String,
    choice: ConflictChoice,
) -> Result<SyncStatus, String> {
    let (session, root) = resolve(&state, &root)?;
    run_blocking(move || build_workspace(session, &root).resolve_conflicts(choice)).await
}

/// 충돌한 파일들의 내 버전·원격 버전 내용을 모아 돌려준다 (FR-4.5 diff 뷰).
#[tauri::command]
pub async fn conflict_preview(
    state: tauri::State<'_, RemoteState>,
    root: String,
) -> Result<Vec<ConflictPreview>, String> {
    let (session, root) = resolve(&state, &root)?;
    run_blocking(move || build_workspace(session, &root).conflict_preview()).await
}

/// GitHub에 리포지토리를 만들고 워크스페이스를 첫 push 한다
#[tauri::command]
pub async fn publish_workspace(
    state: tauri::State<'_, RemoteState>,
    root: String,
    name: String,
    private: bool,
) -> Result<SyncStatus, String> {
    let (session, root) = resolve(&state, &root)?;
    run_blocking(move || {
        let token = stored_token().ok_or("GitHub 로그인이 필요합니다")?;
        let repo = github::create_repo(&UreqHttp, &token, &name, private)?;
        build_workspace(session, &root).publish(&repo.clone_url, "synapse: 초기 게시")
    })
    .await
}

/// 원격 리포지토리를 parent_dir/name 폴더로 클론하고 경로를 돌려준다
#[tauri::command]
pub async fn clone_repo(url: String, parent_dir: String, name: String) -> Result<String, String> {
    run_blocking(move || {
        if !synapse_core::is_safe_file_name(&name) {
            return Err("폴더 이름이 올바르지 않습니다".to_string());
        }
        let dest = Path::new(&parent_dir).join(&name);
        if dest.exists() {
            return Err(format!("이미 존재하는 폴더입니다: {}", dest.display()));
        }
        let auth = stored_token().map(|t| GitWorkspace::auth_header_for_token(&t));
        let path = GitWorkspace::clone(&url, &dest, auth)?;
        Ok(path.display().to_string())
    })
    .await
}

/// 프론트가 넘긴 위치(로컬 경로 또는 ssh:// URI)에서 bare 파일시스템 경로를 뽑는다.
fn bare_path(s: &str) -> Result<String, String> {
    Ok(fs_path(&Location::parse(s).map_err(|e| e.to_string())?)
        .to_string_lossy()
        .into_owned())
}

/// 한 파일의 git 커밋 히스토리 (FR-4.7). 추적되지 않거나 레포가 아니면 빈 목록.
#[tauri::command]
pub async fn file_history(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
) -> Result<Vec<FileCommit>, String> {
    let (session, root) = resolve(&state, &root)?;
    let path = bare_path(&path)?;
    run_blocking(move || {
        // 루트 내부 검증 + git pathspec 상대 경로(로컬/원격 공통 백엔드 가드).
        let rel = backend_of(&session)
            .rel_path_within(Path::new(&root), Path::new(&path))
            .map_err(|e| e.to_string())?;
        build_workspace(session, &root).file_history(&rel)
    })
    .await
}

/// 특정 리비전 시점의 파일 내용 (FR-4.7). 읽기 전용 미리보기·복원에 쓴다.
#[tauri::command]
pub async fn file_at_revision(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
    rev: String,
) -> Result<String, String> {
    let (session, root) = resolve(&state, &root)?;
    let path = bare_path(&path)?;
    run_blocking(move || {
        let rel = backend_of(&session)
            .rel_path_within(Path::new(&root), Path::new(&path))
            .map_err(|e| e.to_string())?;
        build_workspace(session, &root).file_at_revision(&rel, &rev)
    })
    .await
}
