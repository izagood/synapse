//! 워크스페이스 휴지통 기능.
//!
//! 삭제된 파일/폴더를 OS 휴지통(로컬) 또는 워크스페이스 내 전용 디렉토리(원격)로
//! 이동한다. 휴지통은 sync로 다른 기기에 전파되지 않도록 `.git/info/exclude`에
//! 등록되며, 30일 이후 자동 정리된다.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TRASH_DIR_NAME: &str = ".synapse/trash";
pub const TRASH_RETENTION_DAYS: u64 = 30;

fn timestamp_dir_name(timestamp: u64) -> String {
    chrono_lite_from_timestamp(timestamp)
}

fn chrono_lite_from_timestamp(ts: u64) -> String {
    let days = ts / 86400;
    let remainder = ts % 86400;
    let hours = remainder / 3600;
    let mins = (remainder % 3600) / 60;
    let secs = remainder % 60;
    format!("{:08}-{:02}{:02}{:02}", days, hours, mins, secs)
}

pub fn parse_trash_timestamp(dir_name: &str) -> Option<u64> {
    let parts: Vec<&str> = dir_name.split('-').collect();
    if parts.len() != 2 || parts[0].len() != 8 || parts[1].len() != 6 {
        return None;
    }
    let days: u64 = parts[0].parse().ok()?;
    let hours: u64 = parts[1][0..2].parse().ok()?;
    let mins: u64 = parts[1][2..4].parse().ok()?;
    let secs: u64 = parts[1][4..6].parse().ok()?;
    Some(days * 86400 + hours * 3600 + mins * 60 + secs)
}

pub fn should_purge_trash_dir(dir_name: &str, now: SystemTime) -> bool {
    let Some(ts) = parse_trash_timestamp(dir_name) else {
        return false;
    };
    let now_ts = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now_ts > ts && (now_ts - ts) > TRASH_RETENTION_DAYS * 86400
}

pub fn trash_path_for(root: &Path, relative_path: &str, now: SystemTime) -> PathBuf {
    let now_ts = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ts_dir = timestamp_dir_name(now_ts);
    root.join(TRASH_DIR_NAME).join(ts_dir).join(relative_path)
}

pub fn ensure_trash_exclude(workspace_root: &Path) -> std::io::Result<()> {
    let exclude_path = workspace_root.join(".git").join("info").join("exclude");
    if !exclude_path.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&exclude_path)?;
    let target = format!("{}/", TRASH_DIR_NAME);
    if content.lines().any(|line| line.trim() == target) {
        return Ok(());
    }
    let mut new_content = content.trim_end().to_string();
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(&target);
    new_content.push('\n');
    std::fs::write(&exclude_path, new_content)
}

pub fn purge_old_trash(workspace_root: &Path, now: SystemTime) -> std::io::Result<()> {
    let trash_root = workspace_root.join(TRASH_DIR_NAME);
    if !trash_root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&trash_root)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if entry.metadata()?.is_dir() && should_purge_trash_dir(&name, now) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_trash_timestamp_valid() {
        assert_eq!(parse_trash_timestamp("00000000-000000"), Some(0));
        assert_eq!(
            parse_trash_timestamp("00000001-120000"),
            Some(86400 + 12 * 3600)
        );
    }

    #[test]
    fn test_parse_trash_timestamp_invalid() {
        assert_eq!(parse_trash_timestamp("invalid"), None);
        assert_eq!(parse_trash_timestamp("20240101"), None);
        assert_eq!(parse_trash_timestamp("00000000"), None);
    }

    #[test]
    fn test_should_purge_trash_dir() {
        let old_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - (TRASH_RETENTION_DAYS + 1) * 86400;
        let old_name = timestamp_dir_name(old_ts);
        assert!(should_purge_trash_dir(&old_name, SystemTime::now()));

        let recent_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - (TRASH_RETENTION_DAYS - 1) * 86400;
        let recent_name = timestamp_dir_name(recent_ts);
        assert!(!should_purge_trash_dir(&recent_name, SystemTime::now()));
    }

    #[test]
    fn test_timestamp_dir_name_format() {
        let name = timestamp_dir_name(0);
        assert_eq!(name, "00000000-000000");
        let name = timestamp_dir_name(86400 + 12 * 3600);
        assert_eq!(name, "00000001-120000");
    }
}
