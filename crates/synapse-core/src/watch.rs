//! 외부 파일 변경 감시의 순수 정책 (어떤 변경을 reload 트리거로 볼지).
//!
//! OS 파일 워처(`src-tauri/src/watcher.rs`)는 워크스페이스 루트 아래의 모든
//! 파일 이벤트를 받지만, 그중 사용자에게 의미 있는 변경만 프론트로 전달해야
//! 한다. 특히 앱 자신이 쓰는 사이드카(`.synapse/` CRDT 로그, `.git/`,
//! `.*.synapse-tmp` 원자적 저장 임시파일)를 무시해야 reload 피드백 루프가
//! 생기지 않는다.
//!
//! 정책은 `walk.rs`/`tree.rs`의 숨김 항목 규칙과 동일하다: 경로의 어느 한
//! 컴포넌트라도 `.`으로 시작하면 무시한다. 이렇게 하면 `.git`, `.synapse`,
//! `.hidden.md`, `.foo.synapse-tmp`가 모두 한 규칙으로 걸러진다.

use std::path::Path;

/// 워크스페이스 상대경로(슬래시 구분)가 reload를 유발할 만한 변경인지.
///
/// 빈 경로(루트 자신)나 숨김(`.` 시작) 컴포넌트를 포함하면 `false`.
pub fn is_relevant_change(rel: &str) -> bool {
    let mut any = false;
    for seg in rel.split('/') {
        if seg.is_empty() {
            continue;
        }
        any = true;
        if seg.starts_with('.') {
            return false;
        }
    }
    any
}

/// 워처가 받은 절대경로를 루트 기준 상대경로로 바꾸고, 의미 있는 변경이면
/// 슬래시 구분 상대경로를 돌려준다. 루트 밖이거나 숨김 항목이면 `None`.
pub fn relevant_rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    if is_relevant_change(&rel) {
        Some(rel)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn plain_files_are_relevant() {
        assert!(is_relevant_change("note.md"));
        assert!(is_relevant_change("dir/sub/note.md"));
        assert!(is_relevant_change("a-dir/b.txt"));
    }

    #[test]
    fn hidden_components_are_ignored() {
        // 앱 자신이 쓰는 사이드카·git 내부 — reload 루프 방지
        assert!(!is_relevant_change(".synapse/log-abc.y"));
        assert!(!is_relevant_change(".git/index"));
        assert!(!is_relevant_change("notes/.synapse/state.y"));
        assert!(!is_relevant_change(".hidden.md"));
        // 원자적 저장 임시파일 (.foo.md.synapse-tmp)
        assert!(!is_relevant_change("dir/.note.md.synapse-tmp"));
    }

    #[test]
    fn empty_or_root_is_not_relevant() {
        assert!(!is_relevant_change(""));
        assert!(!is_relevant_change("/"));
    }

    #[test]
    fn rel_path_strips_root_and_normalizes() {
        let root = PathBuf::from("/ws");
        assert_eq!(
            relevant_rel_path(&root, &PathBuf::from("/ws/dir/a.md")),
            Some("dir/a.md".to_string())
        );
    }

    #[test]
    fn rel_path_rejects_outside_root_and_hidden() {
        let root = PathBuf::from("/ws");
        assert_eq!(relevant_rel_path(&root, &PathBuf::from("/other/a.md")), None);
        assert_eq!(
            relevant_rel_path(&root, &PathBuf::from("/ws/.synapse/x.y")),
            None
        );
    }
}
