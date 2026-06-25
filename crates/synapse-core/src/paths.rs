use std::io;
use std::path::{Path, PathBuf};

use crate::collab::DATA_DIR;
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

/// PDF의 root-상대 경로를 `.synapse/draw/<rel>.draw.json` 절대경로로 미러링한다.
///
/// 예: root=`/ws`, pdf=`/ws/docs/report.pdf`
///     → `/ws/.synapse/draw/docs/report.pdf.draw.json`
///
/// PDF 주석(드로잉) 사이드카를 사용자에게 보이는 PDF 옆이 아니라 숨김 메타데이터
/// 디렉토리(`.synapse`) 안에 보관하기 위한 경로다. PDF가 root 내부에 실제 존재해야
/// 한다(`rel_path_within`이 canonicalize에 의존). 심링크로 도달한 PDF는 실제 경로
/// 기준의 rel이 되지만, 워크스페이스 내 PDF는 심링크가 아니므로 문제되지 않는다.
///
/// 원격(SFTP) 백엔드도 지원하기 위해 `LocalBackend` 하드코딩 free 함수가 아니라
/// trait 메서드를 쓰는 `backend` 인자를 받는다.
pub fn pdf_draw_sidecar_path(
    backend: &dyn Backend,
    root: &Path,
    pdf: &Path,
) -> io::Result<PathBuf> {
    let rel = backend.rel_path_within(root, pdf)?; // "docs/report.pdf"
    let root_canon = backend.canonicalize(root)?;
    // join이 "/" 포함 문자열을 여러 컴포넌트로 처리한다(주 배포 대상 POSIX). 손split 금지.
    Ok(root_canon
        .join(DATA_DIR)
        .join("draw")
        .join(format!("{rel}.draw.json")))
}

/// 기존(레거시) PDF옆 사이드카 경로. 예: `/ws/a/x.pdf` → `/ws/a/x.pdf.draw.json`.
/// 새 위치로 옮기기 전 데이터를 읽거나, 이전 후 삭제할 때 쓴다.
pub fn legacy_pdf_draw_sidecar(pdf: &Path) -> PathBuf {
    let mut p = pdf.as_os_str().to_os_string();
    p.push(".draw.json");
    PathBuf::from(p)
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

    #[test]
    fn pdf_draw_sidecar_mirrors_nested_path() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("docs/a/report.pdf");
        fs::create_dir_all(pdf.parent().unwrap()).unwrap();
        fs::write(&pdf, "%PDF").unwrap();
        let got = pdf_draw_sidecar_path(&LocalBackend, tmp.path(), &pdf).unwrap();
        let root_canon = LocalBackend.canonicalize(tmp.path()).unwrap();
        assert_eq!(
            got,
            root_canon
                .join(".synapse")
                .join("draw")
                .join("docs/a/report.pdf.draw.json")
        );
    }

    #[test]
    fn pdf_draw_sidecar_handles_root_level_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("x.pdf");
        fs::write(&pdf, "%PDF").unwrap();
        let got = pdf_draw_sidecar_path(&LocalBackend, tmp.path(), &pdf).unwrap();
        let root_canon = LocalBackend.canonicalize(tmp.path()).unwrap();
        assert_eq!(got, root_canon.join(".synapse/draw/x.pdf.draw.json"));
    }

    #[test]
    fn pdf_draw_sidecar_rejects_outside_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("outside.pdf");
        fs::write(&outside, "%PDF").unwrap();
        assert!(pdf_draw_sidecar_path(&LocalBackend, &root, &outside).is_err());
    }

    #[test]
    fn legacy_pdf_draw_sidecar_appends_suffix() {
        assert_eq!(
            legacy_pdf_draw_sidecar(Path::new("/ws/a/x.pdf")),
            PathBuf::from("/ws/a/x.pdf.draw.json")
        );
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
