use std::io;
use std::path::{Path, PathBuf};

use crate::vfs::{Backend, LocalBackend};

// 이 모듈의 파일 연산 헬퍼들은 [`crate::vfs::Backend`]의 기본 제공 메서드로
// 옮겨졌다. 아래 함수들은 로컬 파일시스템([`LocalBackend`])에 위임하는 얇은
// 래퍼로, 기존 호출부와의 호환을 위해 유지한다. 원격(SFTP 등) 경로는
// 호출부에서 적절한 백엔드를 골라 trait 메서드를 직접 호출한다.

pub use crate::vfs::is_safe_file_name;

/// 같은 디렉토리에 임시 파일을 쓴 뒤 rename 하여 원자적으로 저장한다 (NFR-2).
pub fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    LocalBackend.write_atomic(path, content.as_bytes())
}

/// `atomic_write`의 바이너리 버전 (CRDT 스냅샷 등)
pub fn atomic_write_bytes(path: &Path, content: &[u8]) -> io::Result<()> {
    LocalBackend.write_atomic(path, content)
}

/// 아직 존재하지 않을 수 있는 파일의 쓰기 경로를 검증한다.
pub fn ensure_writable_within(root: &Path, candidate: &Path) -> io::Result<PathBuf> {
    LocalBackend.ensure_writable_within(root, candidate)
}

/// `dir` 안에서 겹치지 않는 새 노트 파일을 만들고 경로를 돌려준다.
pub fn create_unique_note(dir: &Path) -> io::Result<PathBuf> {
    LocalBackend.create_unique_note(dir)
}

/// `dir` 안에 `desired_name`으로 바이너리를 쓴다. 같은 이름이 이미 있으면
/// "이름{sep}2.ext"… 로 비켜 쓰고, 최종 파일명을 돌려준다.
pub fn write_unique(dir: &Path, desired_name: &str, bytes: &[u8], sep: &str) -> io::Result<String> {
    LocalBackend.write_unique(dir, desired_name, bytes, sep)
}

/// 파일/폴더 이름 변경. 같은 디렉토리 안에서만, 기존 항목을 덮어쓰지 않는다.
pub fn rename_entry(path: &Path, new_name: &str) -> io::Result<PathBuf> {
    LocalBackend.rename_entry(path, new_name)
}

/// 파일을 같은 폴더에 "이름 2.ext" 식으로 복제하고 새 파일명을 돌려준다.
pub fn duplicate_file(path: &Path) -> io::Result<String> {
    LocalBackend.duplicate_file(path)
}

/// base64 표준 알파벳 인코더 (의존성 없이 — git Basic 인증 헤더 등)
pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// base64 표준 알파벳 디코더 (이미지 붙여넣기용 — 의존성 없이)
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 byte: {c}")),
        }
    }
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b" \n\r\t".contains(b)).collect();
    let stripped = cleaned
        .strip_suffix(b"==")
        .or_else(|| cleaned.strip_suffix(b"="))
        .unwrap_or(&cleaned);
    let mut out = Vec::with_capacity(stripped.len() * 3 / 4);
    for chunk in stripped.chunks(4) {
        let mut acc: u32 = 0;
        for (i, &b) in chunk.iter().enumerate() {
            acc |= val(b)? << (18 - 6 * i);
        }
        let n_bytes = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return Err("truncated base64".to_string()),
        };
        for i in 0..n_bytes {
            out.push(((acc >> (16 - 8 * i)) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
    fn write_unique_keeps_original_name_then_suffixes() {
        let tmp = tempfile::tempdir().unwrap();
        let first = write_unique(tmp.path(), "diagram.png", b"v1", " ").unwrap();
        let second = write_unique(tmp.path(), "diagram.png", b"v2", " ").unwrap();
        assert_eq!(first, "diagram.png");
        assert_eq!(second, "diagram 2.png");
        assert_eq!(fs::read(tmp.path().join("diagram.png")).unwrap(), b"v1");
        assert_eq!(fs::read(tmp.path().join("diagram 2.png")).unwrap(), b"v2");
    }

    #[test]
    fn write_unique_dash_separator_keeps_md_safe_names() {
        let tmp = tempfile::tempdir().unwrap();
        let first = write_unique(tmp.path(), "shot.png", b"v1", "-").unwrap();
        let second = write_unique(tmp.path(), "shot.png", b"v2", "-").unwrap();
        assert_eq!(first, "shot.png");
        assert_eq!(second, "shot-2.png");
    }

    #[test]
    fn rename_entry_moves_and_refuses_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        fs::write(&a, "내용").unwrap();
        let renamed = rename_entry(&a, "b.md").unwrap();
        assert_eq!(renamed.file_name().unwrap().to_string_lossy(), "b.md");
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "내용");
        assert!(!a.exists());

        fs::write(&a, "다른 내용").unwrap();
        assert!(rename_entry(&a, "b.md").is_err()); // 덮어쓰기 금지
        assert!(rename_entry(&a, "x/y.md").is_err()); // 경로 문자 금지
    }

    #[test]
    fn duplicate_file_creates_suffixed_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("note.md");
        fs::write(&a, "원본").unwrap();
        assert_eq!(duplicate_file(&a).unwrap(), "note 2.md");
        assert_eq!(duplicate_file(&a).unwrap(), "note 3.md");
        assert_eq!(
            fs::read_to_string(tmp.path().join("note 2.md")).unwrap(),
            "원본"
        );
    }

    #[test]
    fn safe_file_name_rejects_separators_and_dots() {
        assert!(is_safe_file_name("노트.md"));
        assert!(is_safe_file_name("v1..final.md")); // 구분자가 없으면 탈출 불가
        assert!(!is_safe_file_name(""));
        assert!(!is_safe_file_name("."));
        assert!(!is_safe_file_name(".."));
        assert!(!is_safe_file_name("a/b.md"));
        assert!(!is_safe_file_name("a\\b.md"));
    }

    #[test]
    fn base64_encode_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(
            base64_encode(b"x-access-token:abc"),
            "eC1hY2Nlc3MtdG9rZW46YWJj"
        );
    }

    #[test]
    fn base64_decode_known_vectors() {
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(
            base64_decode("eC1hY2Nlc3MtdG9rZW46YWJj").unwrap(),
            b"x-access-token:abc"
        );
        assert!(base64_decode("!!!").is_err());
    }

    #[test]
    fn creates_unique_note_names() {
        let tmp = tempfile::tempdir().unwrap();
        let first = create_unique_note(tmp.path()).unwrap();
        let second = create_unique_note(tmp.path()).unwrap();
        assert_eq!(first.file_name().unwrap().to_string_lossy(), "새 노트.md");
        assert_eq!(
            second.file_name().unwrap().to_string_lossy(),
            "새 노트 2.md"
        );
        assert!(first.exists() && second.exists());
    }
}
