//! 워크스페이스 파일 순회의 단일 정책 (search/links/git이 공유).
//!
//! - 숨김 항목(`.` 시작: `.git`, `.synapse` 등)은 내려가지도 방문하지도 않는다 (FR-1.6)
//! - 심볼릭 링크는 따라가지 않는다 (순환 방지)
//! - 디렉토리 엔트리를 경로 정렬 후 깊이 우선 순회 → 결과 순서가 결정적이다
//! - 읽을 수 없는 디렉토리/엔트리는 조용히 건너뛴다 (검색·동기화 견고성)
//!
//! `tree.rs`는 중첩 트리(디렉토리 우선 정렬)를 만들어 구조가 다르므로 자체
//! 순회를 유지하되, 같은 숨김/심볼릭 링크 정책을 따른다.

use std::fs;
use std::path::Path;

/// `dir` 아래의 일반 파일을 깊이 우선으로 방문한다.
///
/// visitor는 (절대 경로, 파일명)을 받고, `false`를 반환하면 순회 전체를
/// 중단한다(조기 종료 — 예: 검색 결과 상한 도달). 반환값은 "계속 진행 여부".
pub fn walk_files<F: FnMut(&Path, &str) -> bool>(dir: &Path, visit: &mut F) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return true;
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        // symlink_metadata: 링크를 따라가지 않고 판별 (순환 방지)
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        let ft = meta.file_type();
        if ft.is_dir() {
            if !walk_files(&path, visit) {
                return false;
            }
        } else if ft.is_file() && !visit(&path, &name) {
            return false;
        }
        // 심볼릭 링크는 제외
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn collect(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        walk_files(root, &mut |path, _| {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
            true
        });
        out
    }

    #[test]
    fn visits_files_depth_first_in_sorted_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("b-dir")).unwrap();
        fs::write(root.join("b-dir/inner.md"), "x").unwrap();
        fs::write(root.join("a.md"), "x").unwrap();
        fs::write(root.join("z.md"), "x").unwrap();
        assert_eq!(collect(root), vec!["a.md", "b-dir/inner.md", "z.md"]);
    }

    #[test]
    fn skips_hidden_files_and_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "x").unwrap();
        fs::write(root.join(".hidden.md"), "x").unwrap();
        fs::write(root.join("visible.md"), "x").unwrap();
        assert_eq!(collect(root), vec!["visible.md"]);
    }

    #[test]
    fn stops_when_visitor_returns_false() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "x").unwrap();
        fs::write(root.join("b.md"), "x").unwrap();
        fs::write(root.join("c.md"), "x").unwrap();
        let mut seen: Vec<PathBuf> = Vec::new();
        let finished = walk_files(root, &mut |path, _| {
            seen.push(path.to_path_buf());
            seen.len() < 2
        });
        assert!(!finished);
        assert_eq!(seen.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/note.md"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(root.join("real/note.md"), root.join("linked.md")).unwrap();
        assert_eq!(collect(root), vec!["real/note.md"]);
    }
}
