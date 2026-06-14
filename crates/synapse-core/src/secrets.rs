//! 비밀 토큰(GitHub 토큰·API 키)을 OS 키체인 대신 권한 0600 파일에 보관한다.
//!
//! 왜 키체인을 떠나는가: macOS 키체인은 항목 ACL을 앱의 코드 서명
//! designated requirement에 묶는다. 셀프사인 서명은 사용자 머신에 신뢰
//! 앵커가 없어 업데이트마다 ACL이 무효화되고 "항상 허용"이 매번 다시
//! 요구된다 (Developer ID 서명이 없는 현 배포의 한계). 그래서 키체인 대신
//! 사용자 전용(0600) 파일에 보관한다 — `gh`/`aws` CLI와 같은 모델이다:
//! 같은 사용자 계정의 다른 프로세스로부터는 보호하지 못하지만, 파일 권한과
//! 디스크 암호화(FileVault 등)에 기댄다.
//!
//! 저장 형식은 `{ "<name>": "<secret>" }` JSON 맵 하나다. 모든 함수는 파일
//! 경로를 인자로 받아 부수효과를 격리하므로 단위 테스트가 쉽다.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;

type SecretMap = BTreeMap<String, String>;

/// 파일을 읽어 맵으로 만든다. 파일이 없거나 손상됐으면 빈 맵으로 취급한다
/// (다음 write가 정상 내용으로 복구한다).
fn load(path: &Path) -> SecretMap {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => SecretMap::new(),
    }
}

/// 맵을 부모 디렉터리에 0600 권한으로 원자적으로 저장한다.
fn save(path: &Path, map: &SecretMap) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(map)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_private(path, &json)
}

/// 같은 디렉터리에 0600 임시 파일을 쓴 뒤 rename 한다 (원자적, 권한 보존).
/// 크래시가 나도 기존 파일은 온전하거나 새 내용으로 완전히 교체된 상태만 남는다.
fn write_private(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let tmp = parent.join(format!(".{file_name}.synapse-tmp"));

    write_bytes_0600(&tmp, content)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(unix)]
fn write_bytes_0600(path: &Path, content: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // 이미 존재하던 임시 파일은 mode(0o600)가 무시되므로 명시적으로 강제한다.
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(content)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_bytes_0600(path: &Path, content: &[u8]) -> io::Result<()> {
    // Windows: 사용자 프로필 디렉터리의 NTFS ACL에 기댄다 (gh CLI와 동일).
    std::fs::write(path, content)
}

/// 비밀 항목을 읽는다. 파일이 없거나 항목이 없거나 비어 있으면 `None`.
pub fn read_secret(path: &Path, name: &str) -> Option<String> {
    load(path).remove(name).filter(|v| !v.is_empty())
}

/// 비밀 항목을 저장한다. 파일은 0600 권한으로 만들어진다.
pub fn write_secret(path: &Path, name: &str, value: &str) -> io::Result<()> {
    let mut map = load(path);
    map.insert(name.to_string(), value.to_string());
    save(path, &map)
}

/// 비밀 항목을 지운다. 없으면 no-op (idempotent). 마지막 항목이 사라지면
/// 파일 자체를 제거한다.
pub fn delete_secret(path: &Path, name: &str) -> io::Result<()> {
    let mut map = load(path);
    if map.remove(name).is_none() {
        return Ok(());
    }
    if map.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    save(path, &map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("secrets.json")
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "tok-123").unwrap();
        assert_eq!(read_secret(&p, "github").as_deref(), Some("tok-123"));
    }

    #[test]
    fn missing_file_and_missing_entry_are_none() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        assert_eq!(read_secret(&p, "github"), None);
        write_secret(&p, "github", "tok").unwrap();
        assert_eq!(read_secret(&p, "agent-api-key"), None);
    }

    #[test]
    fn empty_value_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "").unwrap();
        assert_eq!(read_secret(&p, "github"), None);
    }

    #[test]
    fn entries_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "g").unwrap();
        write_secret(&p, "agent-api-key", "k").unwrap();
        assert_eq!(read_secret(&p, "github").as_deref(), Some("g"));
        assert_eq!(read_secret(&p, "agent-api-key").as_deref(), Some("k"));
    }

    #[test]
    fn overwrite_replaces_value() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "old").unwrap();
        write_secret(&p, "github", "new").unwrap();
        assert_eq!(read_secret(&p, "github").as_deref(), Some("new"));
    }

    #[test]
    fn delete_removes_only_target_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "g").unwrap();
        write_secret(&p, "agent-api-key", "k").unwrap();
        delete_secret(&p, "github").unwrap();
        assert_eq!(read_secret(&p, "github"), None);
        assert_eq!(read_secret(&p, "agent-api-key").as_deref(), Some("k"));
        // 두 번 지워도 오류 없음
        delete_secret(&p, "github").unwrap();
    }

    #[test]
    fn deleting_last_entry_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "g").unwrap();
        delete_secret(&p, "github").unwrap();
        assert!(!p.exists());
    }

    #[test]
    fn corrupt_file_is_treated_as_empty_and_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        std::fs::write(&p, b"not json at all").unwrap();
        assert_eq!(read_secret(&p, "github"), None);
        write_secret(&p, "github", "g").unwrap();
        assert_eq!(read_secret(&p, "github").as_deref(), Some("g"));
    }

    #[test]
    fn creates_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir
            .path()
            .join("nested")
            .join("deeper")
            .join("secrets.json");
        write_secret(&p, "github", "g").unwrap();
        assert_eq!(read_secret(&p, "github").as_deref(), Some("g"));
    }

    #[cfg(unix)]
    #[test]
    fn file_has_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_secret(&p, "github", "g").unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "secret file must be readable/writable by owner only"
        );
        // 덮어써도 권한이 유지된다
        write_secret(&p, "github", "g2").unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
