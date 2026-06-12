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

/// 루트 내부로 검증된 경로를 git pathspec용 상대 경로(슬래시 구분)로 바꾼다.
///
/// `ensure_within` 검증을 포함한다. 루트 자신(빈 상대 경로)은 에러.
pub fn rel_path_within(root: &Path, candidate: &Path) -> io::Result<String> {
    let resolved = ensure_within(root, candidate)?;
    let root_canon = root.canonicalize()?;
    let rel = resolved
        .strip_prefix(&root_canon)
        .map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, e.to_string()))?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if rel.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "파일 경로가 비어 있습니다",
        ));
    }
    Ok(rel)
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
