use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

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

fn file_type_of(path: &Path) -> FileType {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("md") | Some("markdown") => FileType::Markdown,
        Some("html") | Some("htm") => FileType::Html,
        _ => FileType::Other,
    }
}

/// 워크스페이스 폴더를 재귀적으로 읽어 파일 트리를 만든다.
///
/// - 숨김 항목(`.`으로 시작, `.git` 포함)은 제외한다 (FR-1.6: 폴더를 오염시키지도, 보여주지도 않는다)
/// - 심볼릭 링크 디렉토리는 순환 방지를 위해 내려가지 않는다
/// - 정렬: 디렉토리 우선, 이름 대소문자 무시 오름차순
pub fn build_tree(root: &Path) -> io::Result<FileNode> {
    let meta = fs::metadata(root)?;
    if !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a directory: {}", root.display()),
        ));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    Ok(FileNode {
        name,
        path: root.display().to_string(),
        kind: NodeKind::Dir,
        file_type: FileType::Other,
        children: Some(read_children(root)?),
    })
}

fn read_children(dir: &Path) -> io::Result<Vec<FileNode>> {
    let mut nodes: Vec<FileNode> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // symlink_metadata: 링크를 따라가지 않고 판별 (순환 방지)
        let ft = entry.path().symlink_metadata()?.file_type();
        let path = entry.path();
        if ft.is_dir() {
            nodes.push(FileNode {
                name,
                path: path.display().to_string(),
                kind: NodeKind::Dir,
                file_type: FileType::Other,
                children: Some(read_children(&path)?),
            });
        } else if ft.is_file() {
            nodes.push(FileNode {
                file_type: file_type_of(&path),
                name,
                path: path.display().to_string(),
                kind: NodeKind::File,
                children: None,
            });
        }
        // 심볼릭 링크는 제외
    }
    nodes.sort_by(|a, b| {
        let rank = |n: &FileNode| if n.kind == NodeKind::Dir { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        touch(&root.join(".hidden.md"));
        touch(&root.join("Alpha/inner.md"));

        let tree = build_tree(root).unwrap();
        let children = tree.children.unwrap();
        let names: Vec<_> = children.iter().map(|c| c.name.as_str()).collect();
        // 디렉토리 우선 + 대소문자 무시 정렬, 숨김 제외
        assert_eq!(names, vec!["Alpha", "zeta", "ai-summary.HTML", "note.md"]);

        assert_eq!(children[0].kind, NodeKind::Dir);
        assert_eq!(children[2].file_type, FileType::Html);
        assert_eq!(children[3].file_type, FileType::Markdown);

        let alpha = &children[0];
        let inner = alpha.children.as_ref().unwrap();
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].name, "inner.md");
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
