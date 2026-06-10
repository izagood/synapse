use std::io;
use std::path::{Path, PathBuf};

/// `candidate`가 `root`(워크스페이스 루트) 내부 경로인지 검증한다.
///
/// 프론트엔드에서 넘어온 경로를 그대로 신뢰하지 않기 위한 가드.
/// 심볼릭 링크·`..`를 모두 해소한 실제 경로 기준으로 비교한다 (NFR-4).
pub fn ensure_within(root: &Path, candidate: &Path) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;
    let resolved = candidate.canonicalize()?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "path escapes workspace root: {} (root: {})",
                candidate.display(),
                root.display()
            ),
        ))
    }
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
