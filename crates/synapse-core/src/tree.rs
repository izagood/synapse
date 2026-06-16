use std::io;
use std::path::Path;

use serde::Serialize;

use crate::vfs::{Backend, LocalBackend};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Dir,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Markdown,
    Html,
    Pdf,
    Image,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: NodeKind,
    pub file_type: FileType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

pub(crate) fn file_type_of(path: &Path) -> FileType {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("md") | Some("markdown") => FileType::Markdown,
        Some("html") | Some("htm") => FileType::Html,
        Some("pdf") => FileType::Pdf,
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("svg")
        | Some("bmp") | Some("ico") | Some("avif") => FileType::Image,
        _ => FileType::Other,
    }
}

/// 워크스페이스 폴더를 재귀적으로 읽어 파일 트리를 만든다 (로컬 파일시스템).
///
/// 실제 트리 빌드 로직은 [`crate::vfs::Backend::build_tree`]에 있다.
/// 원격(SFTP 등) 트리는 호출부에서 해당 백엔드의 trait 메서드를 직접 쓴다.
pub fn build_tree(root: &Path) -> io::Result<FileNode> {
    LocalBackend.build_tree(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::fs::File;

    fn touch(p: &Path) {
        File::create(p).unwrap();
    }

    #[test]
    fn builds_sorted_tree_and_skips_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("zeta")).unwrap();
        fs::create_dir(root.join("Alpha")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        touch(&root.join("note.md"));
        touch(&root.join("ai-summary.HTML"));
        touch(&root.join("report.PDF"));
        touch(&root.join(".hidden.md"));
        touch(&root.join("Alpha/inner.md"));

        let tree = build_tree(root).unwrap();
        let children = tree.children.unwrap();
        let names: Vec<_> = children.iter().map(|c| c.name.as_str()).collect();
        // 디렉토리 우선 + 대소문자 무시 정렬, 숨김 제외
        assert_eq!(
            names,
            vec!["Alpha", "zeta", "ai-summary.HTML", "note.md", "report.PDF"]
        );

        assert_eq!(children[0].kind, NodeKind::Dir);
        assert_eq!(children[2].file_type, FileType::Html);
        assert_eq!(children[3].file_type, FileType::Markdown);
        assert_eq!(children[4].file_type, FileType::Pdf);

        let alpha = &children[0];
        let inner = alpha.children.as_ref().unwrap();
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].name, "inner.md");
    }

    #[test]
    fn detects_image_file_type() {
        use std::path::PathBuf;
        for ext in [
            "png", "JPG", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
        ] {
            let p = PathBuf::from(format!("a.{ext}"));
            assert_eq!(file_type_of(&p), FileType::Image, "ext={ext}");
        }
        assert_eq!(file_type_of(&PathBuf::from("a.txt")), FileType::Other);
    }

    #[test]
    fn rejects_non_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("a.md");
        touch(&f);
        assert!(build_tree(&f).is_err());
    }

    #[test]
    fn serializes_camel_case() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("a.md"));
        let tree = build_tree(tmp.path()).unwrap();
        let json = serde_json::to_string(&tree).unwrap();
        assert!(json.contains("\"fileType\""));
        assert!(json.contains("\"kind\":\"dir\""));
    }
}
