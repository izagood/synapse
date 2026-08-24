use std::io;
use std::path::{Path, PathBuf};

use crate::vfs::{Backend, LocalBackend};

// 경로 가드 로직은 [`crate::vfs::Backend`]의 기본 제공 메서드로 옮겨졌다.
// 아래 함수들은 로컬 파일시스템에 위임하는 얇은 래퍼다.

/// 워크스페이스 안의 숨김 메타데이터 디렉토리 이름(드로잉 사이드카, git 자동
/// 병합에서 제외되는 파일 등에 쓰인다).
pub const DATA_DIR: &str = ".synapse";

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

/// 파일/폴더 조작(rename·move·delete·duplicate)에 맞춰 PDF 주석 사이드카를
/// 동반 처리한다(2차 감사 N3). 사이드카는 `.synapse/draw/<rel>.draw.json`에
/// 상대 경로로 미러링되므로, 본 파일만 옮기면 ① 주석이 화면에서 소멸하고
/// ② 삭제 후 같은 경로에 동명 PDF가 생기면 죽은 주석이 부활한다.
///
/// 주석은 부속 데이터다: 어떤 실패도 본 조작을 되돌리지 않는다(best-effort,
/// Err 반환 없음). 사이드카가 없으면 조용히 통과한다.
///
/// - `old_rel`: 조작 **전** vault 상대 경로(호출자가 조작 전에 계산해 둔다 —
///   조작 후에는 canonicalize가 불가능하다).
/// - `new_rel`: rename/move/duplicate 결과의 상대 경로. delete는 None.
/// - `was_dir`: 폴더 조작이면 미러 디렉토리 전체를 옮기거나 지운다.
/// - `copy`: duplicate처럼 원본 사이드카를 남겨야 하면 true.
pub fn relocate_pdf_draw_sidecar(
    backend: &dyn Backend,
    root: &Path,
    old_rel: &str,
    new_rel: Option<&str>,
    was_dir: bool,
    copy: bool,
) {
    let Ok(root_canon) = backend.canonicalize(root) else {
        return;
    };
    let base = root_canon.join(DATA_DIR).join("draw");
    let mirror = |rel: &str, dir: bool| -> PathBuf {
        if dir {
            base.join(rel)
        } else {
            base.join(format!("{rel}.draw.json"))
        }
    };
    let old = mirror(old_rel, was_dir);
    if backend.metadata(&old).is_err() {
        return; // 주석 없음 — 대부분의 파일이 여기서 끝난다
    }
    match new_rel {
        None => {
            // delete: 부활 방지를 위해 미러도 지운다
            let _ = if was_dir {
                backend.remove_dir_all(&old)
            } else {
                backend.remove_file(&old)
            };
        }
        Some(new_rel) => {
            let target = mirror(new_rel, was_dir);
            if let Some(parent) = target.parent() {
                let _ = backend.create_dir_all(parent);
            }
            if copy && !was_dir {
                if let Ok(bytes) = backend.read(&old) {
                    let _ = backend.write(&target, &bytes);
                }
            } else {
                let _ = backend.rename(&old, &target);
            }
        }
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

    #[test]
    fn relocate_sidecar_follows_file_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/a.pdf"), b"pdf").unwrap();
        let mirror = root.join(".synapse/draw/docs");
        fs::create_dir_all(&mirror).unwrap();
        fs::write(mirror.join("a.pdf.draw.json"), b"{}").unwrap();

        fs::rename(root.join("docs/a.pdf"), root.join("docs/b.pdf")).unwrap();
        relocate_pdf_draw_sidecar(
            &LocalBackend,
            root,
            "docs/a.pdf",
            Some("docs/b.pdf"),
            false,
            false,
        );

        assert!(!mirror.join("a.pdf.draw.json").exists());
        assert!(mirror.join("b.pdf.draw.json").exists());
    }

    #[test]
    fn relocate_sidecar_mirrors_folder_move() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("a/sub")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        let mirror = root.join(".synapse/draw/a/sub");
        fs::create_dir_all(&mirror).unwrap();
        fs::write(mirror.join("x.pdf.draw.json"), b"{}").unwrap();

        fs::rename(root.join("a/sub"), root.join("b/sub")).unwrap();
        relocate_pdf_draw_sidecar(&LocalBackend, root, "a/sub", Some("b/sub"), true, false);

        assert!(!root.join(".synapse/draw/a/sub").exists());
        assert!(root.join(".synapse/draw/b/sub/x.pdf.draw.json").exists());
    }

    #[test]
    fn relocate_sidecar_delete_prevents_resurrection() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mirror = root.join(".synapse/draw");
        fs::create_dir_all(&mirror).unwrap();
        fs::write(mirror.join("a.pdf.draw.json"), b"{}").unwrap();

        relocate_pdf_draw_sidecar(&LocalBackend, root, "a.pdf", None, false, false);
        // 같은 이름의 새 PDF가 생겨도 죽은 주석이 연결되지 않는다
        assert!(!mirror.join("a.pdf.draw.json").exists());
    }

    #[test]
    fn relocate_sidecar_duplicate_copies_and_keeps_original() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mirror = root.join(".synapse/draw");
        fs::create_dir_all(&mirror).unwrap();
        fs::write(mirror.join("a.pdf.draw.json"), b"{\"v\":1}").unwrap();

        relocate_pdf_draw_sidecar(&LocalBackend, root, "a.pdf", Some("a 2.pdf"), false, true);
        assert!(mirror.join("a.pdf.draw.json").exists());
        assert_eq!(
            fs::read(mirror.join("a 2.pdf.draw.json")).unwrap(),
            b"{\"v\":1}"
        );
    }

    #[test]
    fn relocate_sidecar_noop_without_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        // 사이드카·미러 디렉토리 자체가 없어도 조용히 통과한다
        relocate_pdf_draw_sidecar(
            &LocalBackend,
            tmp.path(),
            "a.pdf",
            Some("b.pdf"),
            false,
            false,
        );
        assert!(!tmp.path().join(".synapse").exists());
    }
}
