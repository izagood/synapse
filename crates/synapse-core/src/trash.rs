//! 워크스페이스 휴지통.
//!
//! 삭제된 파일/폴더를 OS 휴지통(로컬) 또는 워크스페이스 안 전용 디렉토리(원격)로
//! 옮긴다. 원격 휴지통은 sync로 다른 기기에 전파되면 안 되므로
//! `.git/info/exclude`에 등록하고, 보관 기간이 지난 것은 자동 정리한다.
//!
//! 원격(SFTP) 워크스페이스에서도 동작해야 하므로 파일 접근은 전부
//! [`Backend`] 경유다 — `std::fs`를 직접 쓰면 원격 경로를 **로컬 파일시스템에서**
//! 찾게 되어 조용히 no-op이 된다(휴지통이 sync로 전파되고 자동 정리도 멈춘다).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::vfs::Backend;

pub const TRASH_DIR_NAME: &str = ".synapse/trash";
pub const TRASH_RETENTION_DAYS: u64 = 30;

/// 휴지통 하위 디렉토리 이름: `YYYYMMDD-HHMMSS`(UTC).
///
/// 사용자가 휴지통을 직접 뒤져 복구할 수 있어야 하므로 사람이 읽는 날짜로 쓴다.
/// (epoch 일수 같은 값은 파싱은 되지만 사용자가 무엇을 지웠는지 알 수 없다.)
fn timestamp_dir_name(ts: u64) -> String {
    let (y, m, d) = civil_from_days((ts / 86400) as i64);
    let rem = ts % 86400;
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// epoch 일수 → (년, 월, 일). Howard Hinnant의 `civil_from_days` 알고리즘.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (년, 월, 일) → epoch 일수. `civil_from_days`의 역함수(정리 판정에 쓴다).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as u64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe as i64 - 719_468
}

/// 휴지통 디렉토리 이름(`YYYYMMDD-HHMMSS`)을 epoch 초로. 형식이 아니면 None.
pub fn parse_trash_timestamp(dir_name: &str) -> Option<u64> {
    let (date, time) = dir_name.split_once('-')?;
    if date.len() != 8
        || time.len() != 6
        || !date.bytes().chain(time.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let y: i64 = date[0..4].parse().ok()?;
    let mo: u32 = date[4..6].parse().ok()?;
    let d: u32 = date[6..8].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let h: u64 = time[0..2].parse().ok()?;
    let mi: u64 = time[2..4].parse().ok()?;
    let s: u64 = time[4..6].parse().ok()?;
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86400 + h * 3600 + mi * 60 + s)
}

fn epoch_secs(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 이 휴지통 디렉토리를 지울 때가 됐는가(보관 기간 초과). 이름이 형식에
/// 맞지 않으면 **지우지 않는다** — 사용자가 넣어둔 것일 수 있다.
pub fn should_purge_trash_dir(dir_name: &str, now: SystemTime) -> bool {
    let Some(ts) = parse_trash_timestamp(dir_name) else {
        return false;
    };
    let now_ts = epoch_secs(now);
    now_ts > ts && (now_ts - ts) > TRASH_RETENTION_DAYS * 86400
}

/// 삭제 대상이 옮겨갈 휴지통 경로: `<root>/.synapse/trash/<YYYYMMDD-HHMMSS>/<rel>`.
pub fn trash_path_for(root: &Path, relative_path: &str, now: SystemTime) -> PathBuf {
    root.join(TRASH_DIR_NAME)
        .join(timestamp_dir_name(epoch_secs(now)))
        .join(relative_path)
}

/// 휴지통이 sync로 전파되지 않도록 `.git/info/exclude`에 등록한다(멱등).
/// git 워크스페이스가 아니거나 접근할 수 없으면 조용히 통과한다 — 삭제 자체를
/// 막지 않는다.
pub fn ensure_trash_exclude(backend: &dyn Backend, root: &Path) -> std::io::Result<()> {
    let exclude = root.join(".git").join("info").join("exclude");
    let Ok(bytes) = backend.read(&exclude) else {
        return Ok(()); // git repo가 아니거나 아직 exclude 파일이 없다
    };
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let entry = format!("{TRASH_DIR_NAME}/");
    if content.lines().any(|l| l.trim() == entry) {
        return Ok(());
    }
    let mut next = content.trim_end().to_string();
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(&entry);
    next.push('\n');
    backend.write_atomic(&exclude, next.as_bytes())
}

/// 보관 기간이 지난 휴지통 디렉토리를 정리한다(best-effort — 실패는 무시).
pub fn purge_old_trash(backend: &dyn Backend, root: &Path, now: SystemTime) {
    let trash_root = root.join(TRASH_DIR_NAME);
    let Ok(entries) = backend.read_dir(&trash_root) else {
        return; // 휴지통이 아직 없다
    };
    for entry in entries {
        if !should_purge_trash_dir(&entry.name, now) {
            continue;
        }
        if backend
            .metadata(&entry.path)
            .map(|m| m.is_dir)
            .unwrap_or(false)
        {
            let _ = backend.remove_dir_all(&entry.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::{InMemoryBackend, LocalBackend};
    use std::time::Duration;

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn timestamp_dir_name_is_human_readable_utc() {
        assert_eq!(timestamp_dir_name(0), "19700101-000000");
        // 2026-08-25 12:34:56 UTC
        let ts = days_from_civil(2026, 8, 25) as u64 * 86400 + 12 * 3600 + 34 * 60 + 56;
        assert_eq!(timestamp_dir_name(ts), "20260825-123456");
    }

    #[test]
    fn parse_trash_timestamp_roundtrips() {
        for ts in [0u64, 1_000_000_000, 1_800_000_000] {
            let name = timestamp_dir_name(ts);
            assert_eq!(parse_trash_timestamp(&name), Some(ts), "{name}");
        }
    }

    #[test]
    fn parse_trash_timestamp_rejects_non_timestamps() {
        for bad in [
            "invalid",
            "20260825",
            "20260825-12345",   // 짧음
            "20260825-1234567", // 김
            "20261325-000000",  // 13월
            "20260832-000000",  // 32일
            "20260825-250000",  // 25시
            "abcdefgh-000000",
            "사용자폴더",
        ] {
            assert_eq!(parse_trash_timestamp(bad), None, "{bad}");
        }
    }

    #[test]
    fn should_purge_only_after_retention() {
        let now = at(1_800_000_000);
        let day = 86400;
        let older = timestamp_dir_name(1_800_000_000 - (TRASH_RETENTION_DAYS + 1) * day);
        let newer = timestamp_dir_name(1_800_000_000 - (TRASH_RETENTION_DAYS - 1) * day);
        assert!(should_purge_trash_dir(&older, now));
        assert!(!should_purge_trash_dir(&newer, now));
        // 형식이 아닌 이름(사용자가 만든 폴더)은 절대 지우지 않는다
        assert!(!should_purge_trash_dir("내 백업", now));
    }

    #[test]
    fn trash_path_mirrors_relative_path() {
        let p = trash_path_for(Path::new("/ws"), "docs/a.md", at(0));
        assert_eq!(p, Path::new("/ws/.synapse/trash/19700101-000000/docs/a.md"));
    }

    #[test]
    fn ensure_exclude_is_idempotent_and_backend_routed() {
        let b = InMemoryBackend::new();
        b.create_dir_all(Path::new("/ws/.git/info")).unwrap();
        b.write(Path::new("/ws/.git/info/exclude"), b"*.log\n")
            .unwrap();
        let root = Path::new("/ws");
        ensure_trash_exclude(&b, root).unwrap();
        ensure_trash_exclude(&b, root).unwrap();
        let out = String::from_utf8(b.read(Path::new("/ws/.git/info/exclude")).unwrap()).unwrap();
        assert_eq!(out.matches(".synapse/trash/").count(), 1, "{out}");
        assert!(out.contains("*.log"), "기존 내용 보존: {out}");
    }

    #[test]
    fn ensure_exclude_is_noop_without_git() {
        let b = InMemoryBackend::new();
        b.create_dir_all(Path::new("/ws")).unwrap();
        // git repo가 아니어도 에러가 아니어야 한다(삭제를 막으면 안 된다)
        ensure_trash_exclude(&b, Path::new("/ws")).unwrap();
    }

    #[test]
    fn purge_removes_only_expired_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let now = at(1_800_000_000);
        let old = timestamp_dir_name(1_800_000_000 - (TRASH_RETENTION_DAYS + 5) * 86400);
        let fresh = timestamp_dir_name(1_800_000_000 - 86400);
        for name in [&old, &fresh, &"사용자폴더".to_string()] {
            let d = root.join(TRASH_DIR_NAME).join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("x.md"), b"x").unwrap();
        }
        purge_old_trash(&LocalBackend, root, now);
        assert!(
            !root.join(TRASH_DIR_NAME).join(&old).exists(),
            "만료분은 삭제"
        );
        assert!(
            root.join(TRASH_DIR_NAME).join(&fresh).exists(),
            "기간 내는 보존"
        );
        assert!(
            root.join(TRASH_DIR_NAME).join("사용자폴더").exists(),
            "형식 아닌 폴더는 보존"
        );
    }
}
