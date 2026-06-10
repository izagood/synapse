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
    let tmp = config_dir.join(format!("{REGISTRY_FILE}.tmp"));
    let text = serde_json::to_string_pretty(registry).map_err(io::Error::other)?;
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &path) // atomic write (NFR-2)
}

/// 최근 연 폴더 목록 (최신순)
pub fn recent_workspaces(config_dir: &Path) -> Vec<String> {
    load(config_dir)
        .recent
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

/// 폴더를 열었음을 기록한다: 중복 제거 후 맨 앞에 추가, 최대 10개 유지.
pub fn record_opened(config_dir: &Path, workspace: &Path) -> io::Result<Vec<String>> {
    let workspace = workspace.display().to_string();
    let mut registry = load(config_dir);
    registry.recent.retain(|p| p != &workspace);
    registry.recent.insert(0, workspace);
    registry.recent.truncate(MAX_RECENT);
    save(config_dir, &registry)?;
    Ok(registry.recent)
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
    fn survives_corrupt_registry_file() {
        let config = tempfile::tempdir().unwrap();
        fs::create_dir_all(config.path()).unwrap();
        fs::write(config.path().join(REGISTRY_FILE), "{ not json").unwrap();
        let ws = tempfile::tempdir().unwrap();
        let recent = record_opened(config.path(), ws.path()).unwrap();
        assert_eq!(recent.len(), 1);
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
