//! 워크스페이스 외부 파일 변경 감시 (OS 네이티브 워처).
//!
//! 사용자가 외부 에디터/동기화 도구로 파일을 바꿔도 수동 새로고침 없이
//! 에디터가 갱신되도록, 워크스페이스 루트를 재귀 감시하다가 의미 있는 변경이
//! 생기면 프론트로 `workspace:files-changed`를 emit한다. 프론트는 이를
//! 받아 (디바운스 후) `reloadAfterSync`를 호출한다.
//!
//! 무엇이 "의미 있는 변경"인지는 순수 정책 `synapse_core::watch`에 있다
//! (숨김/`.synapse`/`.git` 등 앱 자신의 사이드카는 무시 → reload 루프 방지).
//! 디바운스는 프론트에서 하므로 여기서는 원시 이벤트를 필터링만 해 전달한다.
//!
//! 원격(ssh://) 워크스페이스는 OS 워처로 감시할 수 없으므로 무동작이다
//! (기존 동기화 폴링이 변경을 가져온다).

use std::path::PathBuf;
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use synapse_core::location::Location;
use synapse_core::watch::relevant_rel_path;
use tauri::{AppHandle, Emitter, State};

const EVENT_NAME: &str = "workspace:files-changed";

#[derive(Serialize, Clone)]
struct FilesChanged {
    /// 변경된 파일들의 루트 기준 상대경로(슬래시 구분). 비어 있지 않을 때만 emit.
    paths: Vec<String>,
}

/// 현재 감시 중인 핸들. 워처를 drop하면 OS 감시가 중단된다.
struct WatchHandle {
    /// 감시 중인 루트(프론트가 넘긴 원본 문자열) — 같은 루트 재요청 시 no-op 판별용
    root: String,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct WatcherState(Mutex<Option<WatchHandle>>);

/// 워크스페이스 루트 감시를 시작한다(기존 감시는 교체). 로컬 폴더만 감시하며,
/// 원격/파싱 실패 시 기존 감시를 정리하고 조용히 반환한다.
#[tauri::command]
pub fn start_watching(
    app: AppHandle,
    state: State<'_, WatcherState>,
    root: String,
) -> Result<(), String> {
    let base: PathBuf = match Location::parse(&root) {
        Ok(Location::Local(p)) => p,
        // 원격이거나 파싱 실패 → 워처 대상 아님. 이전 감시만 정리.
        _ => {
            *state.0.lock().unwrap() = None;
            return Ok(());
        }
    };

    // 이미 같은 루트를 감시 중이면 그대로 둔다(중복 watch 방지).
    if state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|h| h.root == root)
    {
        return Ok(());
    }

    let app_for_cb = app.clone();
    let base_for_cb = base.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            // 생성·수정·삭제만 관심 대상 (액세스/메타데이터-only는 무시).
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter_map(|p| relevant_rel_path(&base_for_cb, p))
                .collect();
            if !paths.is_empty() {
                let _ = app_for_cb.emit(EVENT_NAME, FilesChanged { paths });
            }
        })
        .map_err(|e| e.to_string())?;

    watcher
        .watch(&base, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(WatchHandle {
        root,
        _watcher: watcher,
    });
    Ok(())
}

/// 감시를 중단한다(idempotent). 워크스페이스를 닫을 때 호출한다.
#[tauri::command]
pub fn stop_watching(state: State<'_, WatcherState>) -> Result<(), String> {
    *state.0.lock().unwrap() = None;
    Ok(())
}
