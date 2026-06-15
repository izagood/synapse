use std::io;
use std::path::{Path, PathBuf};

use crate::vfs::{Backend, LocalBackend};

// 경로 가드 로직은 [`crate::vfs::Backend`]의 기본 제공 메서드로 옮겨졌다.
// 아래 함수들은 로컬 파일시스템에 위임하는 얇은 래퍼다.

/// `candidate`가 `root`(워크스페이스 루트) 내부 경로인지 검증한다 (NFR-4).
pub fn ensure_within(root: &Path, candidate: &Path) -> io::Result<PathBuf> {
    LocalBackend.ensure_within(root, candidate)
}

/// 루트 내부로 검증된 경로를 git pathspec용 상대 경로(슬래시 구분)로 바꾼다.
pub fn rel_path_within(root: &Path, candidate: &Path) -> io::Result<String> {
    LocalBackend.rel_path_within(root, candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn accepts_inside_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let inner = tmp.path().join("a/b.md");
        fs::create_dir_all(inner.parent().unwrap()).unwrap();
        fs::write(&inner, "x").unwrap();
        assert!(ensure_within(tmp.path(), &inner).is_ok());
    }

    #[test]
    fn rejects_dotdot_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let escape = sub.join("../../");
        assert!(ensure_within(&sub, &escape).is_err());
    }

    #[test]
    fn rel_path_within_returns_slash_separated_relative() {
        let tmp = tempfile::tempdir().unwrap();
        let inner = tmp.path().join("a/b.md");
        fs::create_dir_all(inner.parent().unwrap()).unwrap();
        fs::write(&inner, "x").unwrap();
        assert_eq!(rel_path_within(tmp.path(), &inner).unwrap(), "a/b.md");
    }

    #[test]
    fn rel_path_within_rejects_root_itself_and_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        assert!(rel_path_within(&sub, &sub).is_err()); // 빈 상대 경로
        assert!(rel_path_within(&sub, tmp.path()).is_err()); // 루트 밖
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside.md");
        fs::create_dir(&root).unwrap();
        fs::write(&outside, "secret").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(ensure_within(&root, &link).is_err());
    }
}
