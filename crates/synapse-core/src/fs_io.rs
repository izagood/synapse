use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 같은 디렉토리에 임시 파일을 쓴 뒤 rename 하여 원자적으로 저장한다 (NFR-2).
/// 크래시가 나도 기존 파일은 온전하거나 새 내용으로 완전히 교체된 상태만 남는다.
pub fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let tmp = parent.join(format!(".{file_name}.synapse-tmp"));
    fs::write(&tmp, content)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// 아직 존재하지 않을 수 있는 파일의 쓰기 경로를 검증한다.
///
/// `ensure_within`은 대상 파일을 canonicalize 하므로 새 파일에는 쓸 수 없다.
/// 대신 부모 디렉토리가 워크스페이스 루트 안인지 확인하고,
/// 파일명에 경로 구분자가 섞여 들어오는 것을 차단한다.
pub fn ensure_writable_within(root: &Path, candidate: &Path) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;
    let parent = candidate
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?
        .canonicalize()?;
    if !parent.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("path escapes workspace root: {}", candidate.display()),
        ));
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let name_str = name.to_string_lossy();
    if name_str == "." || name_str == ".." {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"));
    }
    Ok(parent.join(name))
}

/// `dir` 안에서 겹치지 않는 새 노트 파일을 만들고 경로를 돌려준다.
/// "새 노트.md", "새 노트 2.md", … 순서로 시도한다.
pub fn create_unique_note(dir: &Path) -> io::Result<PathBuf> {
    for i in 1..1000 {
        let name = if i == 1 {
            "새 노트.md".to_string()
        } else {
            format!("새 노트 {i}.md")
        };
        let path = dir.join(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("too many untitled notes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.md");
        atomic_write(&file, "v1").unwrap();
        atomic_write(&file, "v2").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("synapse-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn writable_guard_allows_new_file_inside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("new-note.md");
        let resolved = ensure_writable_within(tmp.path(), &target).unwrap();
        assert!(resolved.ends_with("new-note.md"));
    }

    #[test]
    fn writable_guard_rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let escape = sub.join("../evil.md");
        assert!(ensure_writable_within(&sub, &escape).is_err());
    }

    #[test]
    fn creates_unique_note_names() {
        let tmp = tempfile::tempdir().unwrap();
        let first = create_unique_note(tmp.path()).unwrap();
        let second = create_unique_note(tmp.path()).unwrap();
        assert_eq!(first.file_name().unwrap().to_string_lossy(), "새 노트.md");
        assert_eq!(second.file_name().unwrap().to_string_lossy(), "새 노트 2.md");
        assert!(first.exists() && second.exists());
    }
}
