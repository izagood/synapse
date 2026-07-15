use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

const REGISTRY_FILE: &str = "workspaces.json";
const MAX_RECENT: usize = 10;

/// 전역 워크스페이스 레지스트리 (FR-5.5)
///
/// 폴더별 상태를 사용자 폴더가 아닌 앱 설정 디렉토리 한 곳에 저장한다.
/// `workspaces` 맵은 M3(동기화)에서 리포지토리 연결 정보 등을 담을 예정이라
/// 지금은 임의 JSON으로 보존만 한다.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub recent: Vec<String>,
    /// 마지막으로 열려 있던 워크스페이스 — 앱 재시작 시 세션 복원용.
    /// 사용자가 명시적으로 닫으면(시작 화면으로) None.
    #[serde(default)]
    pub last_workspace: Option<String>,
    #[serde(default)]
    pub workspaces: BTreeMap<String, serde_json::Value>,
}

fn load(config_dir: &Path) -> Registry {
    let path = config_dir.join(REGISTRY_FILE);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Registry::default(),
    }
}

fn save(config_dir: &Path, registry: &Registry) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let path = config_dir.join(REGISTRY_FILE);
    let text = serde_json::to_string_pretty(registry).map_err(io::Error::other)?;
    crate::fs_io::atomic_write(&path, &text) // atomic write (NFR-2)
}

/// 워크스페이스 식별자가 목록에 남을 자격이 있는지.
/// 로컬은 실제 폴더가 있어야 하고, 원격(`ssh://`)은 연결 없이 존재를 알 수 없으므로
/// 항상 유지한다(연결은 사용자가 다시 시도).
fn is_listable(id: &str) -> bool {
    id.starts_with("ssh://") || Path::new(id).is_dir()
}

/// 최근 연 폴더 목록 (최신순)
pub fn recent_workspaces(config_dir: &Path) -> Vec<String> {
    load(config_dir)
        .recent
        .into_iter()
        .filter(|p| is_listable(p))
        .collect()
}

/// 폴더를 열었음을 기록한다: 중복 제거 후 맨 앞에 추가, 최대 10개 유지.
/// 세션 복원을 위해 마지막 워크스페이스로도 표시한다.
pub fn record_opened(config_dir: &Path, workspace: &Path) -> io::Result<Vec<String>> {
    let workspace = workspace.display().to_string();
    let mut registry = load(config_dir);
    registry.recent.retain(|p| p != &workspace);
    registry.recent.insert(0, workspace.clone());
    registry.recent.truncate(MAX_RECENT);
    registry.last_workspace = Some(workspace);
    save(config_dir, &registry)?;
    Ok(registry.recent)
}

/// 최근 연 폴더 목록을 전부 비운다 (시작 화면 "모두 지우기").
/// 세션 복원용 last_workspace와 워크스페이스별 상태는 건드리지 않는다.
pub fn clear_recent(config_dir: &Path) -> io::Result<()> {
    let mut registry = load(config_dir);
    registry.recent.clear();
    save(config_dir, &registry)
}

/// 앱 재시작 시 복원할 워크스페이스 (삭제된 로컬 폴더면 None, 원격은 유지)
pub fn last_workspace(config_dir: &Path) -> Option<String> {
    load(config_dir).last_workspace.filter(|p| is_listable(p))
}

/// 사용자가 워크스페이스를 명시적으로 닫음 — 다음 시작은 시작 화면
pub fn clear_last_workspace(config_dir: &Path) -> io::Result<()> {
    let mut registry = load(config_dir);
    registry.last_workspace = None;
    save(config_dir, &registry)
}

/// 워크스페이스별 세션 상태(열린 탭 등)를 읽는다 (FR-5.5)
pub fn workspace_state(config_dir: &Path, workspace: &Path) -> serde_json::Value {
    load(config_dir)
        .workspaces
        .get(&workspace.display().to_string())
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

/// 워크스페이스별 세션 상태를 저장한다. 기존 항목의 다른 키(예: 추후
/// 리포지토리 메타데이터)는 보존하고 주어진 키만 덮어쓴다.
pub fn set_workspace_state(
    config_dir: &Path,
    workspace: &Path,
    state: serde_json::Value,
) -> io::Result<()> {
    let mut registry = load(config_dir);
    let entry = registry
        .workspaces
        .entry(workspace.display().to_string())
        .or_insert_with(|| serde_json::json!({}));
    match (entry.as_object_mut(), state.as_object()) {
        (Some(existing), Some(new)) => {
            for (k, v) in new {
                existing.insert(k.clone(), v.clone());
            }
        }
        _ => *entry = state,
    }
    save(config_dir, &registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_dedupes_and_caps() {
        let config = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();

        record_opened(config.path(), ws.path()).unwrap();
        record_opened(config.path(), ws.path()).unwrap();
        let recent = recent_workspaces(config.path());
        assert_eq!(recent, vec![ws.path().display().to_string()]);

        // 10개 초과 시 잘림 (존재하는 디렉토리만 유지되므로 실제 디렉토리로 채움)
        let extra: Vec<_> = (0..12).map(|_| tempfile::tempdir().unwrap()).collect();
        for d in &extra {
            record_opened(config.path(), d.path()).unwrap();
        }
        let recent = recent_workspaces(config.path());
        assert_eq!(recent.len(), MAX_RECENT);
        assert_eq!(recent[0], extra[11].path().display().to_string());
    }

    #[test]
    fn filters_out_deleted_folders() {
        let config = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        record_opened(config.path(), ws.path()).unwrap();
        drop(ws); // 폴더 삭제
        assert!(recent_workspaces(config.path()).is_empty());
    }

    #[test]
    fn keeps_remote_ssh_uris_without_local_existence_check() {
        let config = tempfile::tempdir().unwrap();
        let remote = Path::new("ssh://me@host:2222/srv/notes");
        record_opened(config.path(), remote).unwrap();
        // 원격 URI는 로컬에 존재하지 않아도 최근 목록·복원 대상으로 유지된다
        assert_eq!(
            recent_workspaces(config.path()),
            vec!["ssh://me@host:2222/srv/notes".to_string()]
        );
        assert_eq!(
            last_workspace(config.path()),
            Some("ssh://me@host:2222/srv/notes".to_string())
        );
    }

    #[test]
    fn clear_recent_empties_list_but_keeps_session_state() {
        let config = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        record_opened(config.path(), ws.path()).unwrap();
        set_workspace_state(config.path(), ws.path(), serde_json::json!({"openTabs": ["a.md"]}))
            .unwrap();

        clear_recent(config.path()).unwrap();

        assert!(recent_workspaces(config.path()).is_empty());
        // 최근 목록만 비운다 — 세션 복원과 탭 상태는 그대로
        assert_eq!(
            last_workspace(config.path()),
            Some(ws.path().display().to_string())
        );
        assert_eq!(
            workspace_state(config.path(), ws.path())["openTabs"][0],
            "a.md"
        );
    }

    #[test]
    fn survives_corrupt_registry_file() {
        let config = tempfile::tempdir().unwrap();
        fs::create_dir_all(config.path()).unwrap();
        fs::write(config.path().join(REGISTRY_FILE), "{ not json").unwrap();
        let ws = tempfile::tempdir().unwrap();
        let recent = record_opened(config.path(), ws.path()).unwrap();
        assert_eq!(recent.len(), 1);
    }

    #[test]
    fn tracks_and_clears_last_workspace() {
        let config = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        record_opened(config.path(), ws.path()).unwrap();
        assert_eq!(
            last_workspace(config.path()),
            Some(ws.path().display().to_string())
        );

        clear_last_workspace(config.path()).unwrap();
        assert_eq!(last_workspace(config.path()), None);

        // 삭제된 폴더는 복원 대상이 아니다
        record_opened(config.path(), ws.path()).unwrap();
        drop(ws);
        assert_eq!(last_workspace(config.path()), None);
    }

    #[test]
    fn workspace_state_merges_keys_preserving_others() {
        let config = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        set_workspace_state(
            config.path(),
            ws.path(),
            serde_json::json!({"remote": "git@github.com:a/b.git"}),
        )
        .unwrap();
        set_workspace_state(
            config.path(),
            ws.path(),
            serde_json::json!({"openTabs": ["a.md"], "activePath": "a.md"}),
        )
        .unwrap();

        let state = workspace_state(config.path(), ws.path());
        assert_eq!(state["remote"], "git@github.com:a/b.git"); // 기존 키 보존
        assert_eq!(state["openTabs"][0], "a.md");

        let missing = tempfile::tempdir().unwrap();
        assert!(workspace_state(config.path(), missing.path()).is_null());
    }

    #[test]
    fn preserves_unknown_workspace_metadata() {
        let config = tempfile::tempdir().unwrap();
        fs::create_dir_all(config.path()).unwrap();
        fs::write(
            config.path().join(REGISTRY_FILE),
            r#"{"recent":[],"workspaces":{"/x":{"remote":"git@github.com:a/b.git"}}}"#,
        )
        .unwrap();
        let ws = tempfile::tempdir().unwrap();
        record_opened(config.path(), ws.path()).unwrap();
        let text = fs::read_to_string(config.path().join(REGISTRY_FILE)).unwrap();
        assert!(text.contains("git@github.com:a/b.git"));
    }
}
