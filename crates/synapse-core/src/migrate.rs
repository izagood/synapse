//! 워크스페이스 열기 시 한 번씩 도는 마이그레이션.
//!
//! 지금은 레거시 CRDT 데이터 디렉토리(`.synapse`, Task 4에서 삭제된
//! `collab.rs`의 영속 스토어가 쓰던 곳) 정리 하나뿐이다. 디스크가 단일
//! SoT가 된 지금 그 안의 CRDT 로그/상태 파일은 어떤 경로에서도 더 이상
//! 읽히지 않는 죽은 데이터라, 워크스페이스를 열 때마다 치운다. 지운 결과는
//! 다음 sync의 `git add -A` 커밋에 자연히 실려 다른 기기에도 퍼진다.

use std::io;
use std::path::Path;

use crate::paths::DATA_DIR;
use crate::vfs::Backend;

/// 워크스페이스 루트 아래 `.synapse`의 레거시 잔재를 정리한다.
///
/// 주의: `.synapse`는 CRDT 스토어 전용이 아니다. PDF 드로잉 사이드카
/// ([`crate::paths::pdf_draw_sidecar_path`])가 지금도 `.synapse/draw/` 아래에
/// 실사용 데이터(사용자 주석)를 두므로, 디렉토리 전체를 무조건 밀어버리면
/// 워크스페이스를 열 때마다 주석이 사라지는 사고가 난다. 그래서 `draw/`
/// 서브디렉토리는 보존하고, 그 옆에 남은 레거시 항목(과거 CRDT 로그/상태
/// 파일 등)만 지운다. 정리 후 `draw/`조차 없어 디렉토리가 완전히 비면 빈
/// 디렉토리 자체도 지운다.
///
/// 반환값: 실제로 뭔가(레거시 항목 또는 다 비워진 디렉토리 자체)를 지웠으면
/// `Ok(true)`. `.synapse`가 애초에 없었거나, 있어도 `draw/`만 남아 있어
/// 지울 레거시 항목이 없었으면 `Ok(false)`.
pub fn remove_collab_dir(backend: &dyn Backend, root: &Path) -> io::Result<bool> {
    let root = backend.canonicalize(root)?;
    let dir = root.join(DATA_DIR);
    if !backend.exists(&dir) {
        return Ok(false);
    }
    // root.join(DATA_DIR)은 canonicalize된 root 밑이라 이미 내부이지만,
    // 심링크로 밖을 가리키는 `.synapse`(신뢰 못 할 상태)까지 방어하기 위해
    // 실제 해소 경로 기준으로 다시 검증한다 (NFR-4와 동일한 관용구).
    let dir = backend.ensure_within(&root, &dir)?;

    let mut removed_any = false;
    for entry in backend.read_dir(&dir)? {
        if entry.name == "draw" {
            continue; // PDF 드로잉 사이드카 — 실사용 데이터라 보존한다
        }
        let meta = backend.symlink_metadata(&entry.path)?;
        if meta.is_dir {
            backend.remove_dir_all(&entry.path)?;
        } else {
            backend.remove_file(&entry.path)?;
        }
        removed_any = true;
    }

    if backend.read_dir(&dir)?.is_empty() {
        backend.remove_dir_all(&dir)?;
        removed_any = true;
    }

    Ok(removed_any)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::LocalBackend;
    use std::fs;

    #[test]
    fn removes_existing_dir_with_nested_files_and_returns_true() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".synapse");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("state.log"), b"legacy crdt log").unwrap();
        fs::write(dir.join("sub/nested.bin"), b"legacy").unwrap();

        let removed = remove_collab_dir(&LocalBackend, tmp.path()).unwrap();

        assert!(removed);
        assert!(!dir.exists());
    }

    #[test]
    fn returns_false_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let removed = remove_collab_dir(&LocalBackend, tmp.path()).unwrap();
        assert!(!removed);
    }

    #[test]
    fn preserves_pdf_draw_sidecars_while_removing_legacy_siblings() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".synapse");
        fs::create_dir_all(dir.join("draw")).unwrap();
        fs::write(dir.join("draw/report.pdf.draw.json"), b"{}").unwrap();
        fs::write(dir.join("legacy.log"), b"legacy crdt log").unwrap();

        let removed = remove_collab_dir(&LocalBackend, tmp.path()).unwrap();

        assert!(removed); // legacy.log는 지워졌다
        assert!(dir.join("draw/report.pdf.draw.json").exists()); // 사이드카는 보존
        assert!(!dir.join("legacy.log").exists());
    }

    #[test]
    fn noop_when_only_draw_subdir_remains() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".synapse");
        fs::create_dir_all(dir.join("draw")).unwrap();
        fs::write(dir.join("draw/report.pdf.draw.json"), b"{}").unwrap();

        let removed = remove_collab_dir(&LocalBackend, tmp.path()).unwrap();

        assert!(!removed); // 지울 레거시 항목이 없었다
        assert!(dir.join("draw/report.pdf.draw.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_synapse_symlinked_outside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"do not touch").unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".synapse")).unwrap();

        let err = remove_collab_dir(&LocalBackend, &root).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(outside.join("secret.txt").exists()); // 밖은 그대로
    }
}
