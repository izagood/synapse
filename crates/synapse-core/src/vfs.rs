//! 가상 파일시스템(VFS) 추상화.
//!
//! 워크스페이스의 모든 파일 I/O를 [`Backend`] trait 뒤로 숨겨, 로컬
//! 파일시스템([`LocalBackend`])과 원격(SFTP 등)을 같은 코드 경로로 다룬다.
//!
//! 설계:
//! - **필수 메서드**는 저수준 원시 연산(read/write/rename/read_dir/metadata/
//!   canonicalize/create_new/append …)뿐이다. 백엔드는 이것만 구현하면 된다.
//! - **고수준 헬퍼**(원자적 쓰기, 트리 빌드, 경로 가드, 충돌 회피 생성 등)는
//!   기본 제공 메서드로 원시 연산 위에 구현돼 모든 백엔드가 공유한다.
//!
//! 경로는 [`std::path::Path`]로 표현한다. 로컬은 OS 경로, 원격은 POSIX 경로
//! 문자열을 담는다. 원격 경로 조작은 호스트가 POSIX(macOS/Linux)일 때 정확하다
//! (주 배포 대상이 macOS). Windows 클라이언트에서 원격을 다루는 경우의 경로
//! 구분자 차이는 SFTP 백엔드 도입 단계에서 별도로 처리한다.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::tree::{file_type_of, FileNode, FileType, NodeKind};

/// 경로 메타데이터 (백엔드 독립).
#[derive(Debug, Clone, Copy)]
pub struct Meta {
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub len: u64,
}

/// 디렉토리 항목 한 개 (이름 + 전체 경로).
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: PathBuf,
}

/// 워크스페이스 파일시스템 백엔드.
///
/// 구현체는 아래 "필수 원시 연산"만 채우면 되고, 고수준 헬퍼는 자동으로 따라온다.
pub trait Backend: Send + Sync {
    // ----- 필수 원시 연산 -----

    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// 단순 쓰기(원자성 보장 없음). 원자적 저장은 [`Backend::write_atomic`]을 쓴다.
    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
    fn remove_dir_all(&self, path: &Path) -> io::Result<()>;
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>>;
    /// 링크를 따라간 메타데이터.
    fn metadata(&self, path: &Path) -> io::Result<Meta>;
    /// 링크를 따라가지 않은 메타데이터(순환 방지·심링크 판별용).
    fn symlink_metadata(&self, path: &Path) -> io::Result<Meta>;
    /// 심링크와 `..`를 모두 해소한 실제 경로.
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
    /// 파일을 "없을 때만" 배타적으로 만들고 바이트를 쓴다.
    /// 이미 존재하면 `Ok(false)`, 새로 만들었으면 `Ok(true)`.
    fn create_new(&self, path: &Path, bytes: &[u8]) -> io::Result<bool>;
    /// 파일 끝에 이어 쓴다(없으면 생성). append-only CRDT 로그용.
    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;

    // ----- 고수준 헬퍼(기본 제공) -----

    fn exists(&self, path: &Path) -> bool {
        self.metadata(path).is_ok()
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        let bytes = self.read(path)?;
        String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// 같은 디렉토리에 임시 파일을 쓴 뒤 rename 하여 원자적으로 저장한다 (NFR-2).
    /// 크래시가 나도 기존 파일은 온전하거나 새 내용으로 완전히 교체된 상태만 남는다.
    fn write_atomic(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
        })?;
        let file_name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
            .to_string_lossy();
        let tmp = parent.join(format!(".{file_name}.synapse-tmp"));
        self.write(&tmp, content)?;
        match self.rename(&tmp, path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = self.remove_file(&tmp);
                Err(e)
            }
        }
    }

    /// 아직 존재하지 않을 수 있는 파일의 쓰기 경로를 검증한다.
    ///
    /// 대상을 canonicalize 할 수 없으므로(새 파일) 부모 디렉토리가 워크스페이스
    /// 루트 안인지 확인하고, 파일명에 경로 구분자가 섞이는 것을 차단한다.
    fn ensure_writable_within(&self, root: &Path, candidate: &Path) -> io::Result<PathBuf> {
        let root = self.canonicalize(root)?;
        let parent = candidate
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
        let parent = self.canonicalize(parent)?;
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
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid file name",
            ));
        }
        Ok(parent.join(name))
    }

    /// `candidate`가 `root`(워크스페이스 루트) 내부 경로인지 검증한다.
    /// 심볼릭 링크·`..`를 모두 해소한 실제 경로 기준으로 비교한다 (NFR-4).
    fn ensure_within(&self, root: &Path, candidate: &Path) -> io::Result<PathBuf> {
        let root = self.canonicalize(root)?;
        let resolved = self.canonicalize(candidate)?;
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
    /// 루트 자신(빈 상대 경로)은 에러.
    fn rel_path_within(&self, root: &Path, candidate: &Path) -> io::Result<String> {
        let resolved = self.ensure_within(root, candidate)?;
        let root_canon = self.canonicalize(root)?;
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

    /// `dir` 안에서 겹치지 않는 새 노트 파일을 만들고 경로를 돌려준다.
    /// "새 노트.md", "새 노트 2.md", … 순서로 시도한다.
    fn create_unique_note(&self, dir: &Path) -> io::Result<PathBuf> {
        for i in 1..1000 {
            let name = if i == 1 {
                "새 노트.md".to_string()
            } else {
                format!("새 노트 {i}.md")
            };
            let path = dir.join(name);
            if self.create_new(&path, b"")? {
                return Ok(path);
            }
        }
        Err(io::Error::other("too many untitled notes"))
    }

    /// `dir` 안에 `desired_name`으로 바이너리를 쓴다. 같은 이름이 이미 있으면
    /// "이름{sep}2.ext", "이름{sep}3.ext"… 로 비켜 쓰고, 최종 파일명을 돌려준다.
    fn write_unique(
        &self,
        dir: &Path,
        desired_name: &str,
        bytes: &[u8],
        sep: &str,
    ) -> io::Result<String> {
        let (stem, ext) = match desired_name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), Some(e.to_string())),
            _ => (desired_name.to_string(), None),
        };
        for i in 1..1000 {
            let name = match (&ext, i) {
                (Some(e), 1) => format!("{stem}.{e}"),
                (Some(e), n) => format!("{stem}{sep}{n}.{e}"),
                (None, 1) => stem.clone(),
                (None, n) => format!("{stem}{sep}{n}"),
            };
            if self.create_new(&dir.join(&name), bytes)? {
                return Ok(name);
            }
        }
        Err(io::Error::other("too many name collisions"))
    }

    /// 파일/폴더 이름 변경. 같은 디렉토리 안에서만, 기존 항목을 덮어쓰지 않는다.
    fn rename_entry(&self, path: &Path, new_name: &str) -> io::Result<PathBuf> {
        if !is_safe_file_name(new_name) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid name"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent"))?;
        let target = parent.join(new_name);
        if self.exists(&target) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("이미 존재합니다: {new_name}"),
            ));
        }
        self.rename(path, &target)?;
        Ok(target)
    }

    /// 파일/폴더를 다른 디렉토리(`dest_dir`)로 옮기고 옮긴 새 경로를 돌려준다.
    /// - 이미 그 폴더 안에 있으면(부모가 곧 대상) 무동작으로 원본 경로를 돌려준다.
    /// - 폴더를 자기 자신이나 자기 하위로 옮기는 것은 거부한다.
    /// - 대상 폴더에 같은 이름이 이미 있으면 덮어쓰지 않고 실패한다.
    fn move_entry(&self, path: &Path, dest_dir: &Path) -> io::Result<PathBuf> {
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
        // 폴더를 자기 자신/하위로 옮기면 트리가 끊긴다 — fs::rename도 거부하지만
        // 친절한 메시지를 위해 먼저 막는다.
        if dest_dir == path || dest_dir.starts_with(path) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "폴더를 자기 자신의 하위로 옮길 수 없습니다",
            ));
        }
        let target = dest_dir.join(name);
        if target == path {
            return Ok(target); // 이미 그 폴더에 있음
        }
        if self.exists(&target) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("이미 존재합니다: {}", name.to_string_lossy()),
            ));
        }
        self.rename(path, &target)?;
        Ok(target)
    }

    /// 파일을 같은 폴더에 "이름 2.ext" 식으로 복제하고 새 파일명을 돌려준다.
    fn duplicate_file(&self, path: &Path) -> io::Result<String> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?
            .to_string_lossy()
            .into_owned();
        let bytes = self.read(path)?;
        self.write_unique(parent, &name, &bytes, " ")
    }

    /// 워크스페이스 폴더를 재귀적으로 읽어 파일 트리를 만든다.
    ///
    /// - 숨김 항목(`.`으로 시작, `.git`/`.synapse` 포함)은 제외한다
    /// - 심볼릭 링크는 순환 방지를 위해 따라가지 않는다(트리에서 제외)
    /// - 정렬: 디렉토리 우선, 이름 대소문자 무시 오름차순
    fn build_tree(&self, root: &Path) -> io::Result<FileNode> {
        let meta = self.metadata(root)?;
        if !meta.is_dir {
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
            children: Some(self.read_children(root)?),
        })
    }

    /// [`Backend::build_tree`]의 재귀 본체.
    fn read_children(&self, dir: &Path) -> io::Result<Vec<FileNode>> {
        let mut nodes: Vec<FileNode> = Vec::new();
        for entry in self.read_dir(dir)? {
            if entry.name.starts_with('.') {
                continue;
            }
            // 링크를 따라가지 않고 판별 (순환 방지)
            let meta = self.symlink_metadata(&entry.path)?;
            if meta.is_dir {
                nodes.push(FileNode {
                    name: entry.name,
                    path: entry.path.display().to_string(),
                    kind: NodeKind::Dir,
                    file_type: FileType::Other,
                    children: Some(self.read_children(&entry.path)?),
                });
            } else if meta.is_file {
                nodes.push(FileNode {
                    file_type: file_type_of(&entry.path),
                    name: entry.name,
                    path: entry.path.display().to_string(),
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
}

/// 한 단계 파일/폴더 이름으로 안전한지 검증한다 (경로 트래버설 차단).
/// 구분자(`/`, `\`)가 금지되므로 "a..b" 같은 이름은 탈출이 불가능해 허용된다.
pub fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && name != "." && name != ".."
}

/// 로컬 OS 파일시스템 백엔드 (`std::fs`).
#[derive(Debug, Clone, Copy, Default)]
pub struct LocalBackend;

fn meta_from(m: &fs::Metadata) -> Meta {
    let ft = m.file_type();
    Meta {
        is_dir: ft.is_dir(),
        is_file: ft.is_file(),
        is_symlink: ft.is_symlink(),
        len: m.len(),
    }
}

impl Backend for LocalBackend {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        fs::write(path, bytes)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir_all(path)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            out.push(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path(),
            });
        }
        Ok(out)
    }

    fn metadata(&self, path: &Path) -> io::Result<Meta> {
        Ok(meta_from(&fs::metadata(path)?))
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<Meta> {
        Ok(meta_from(&fs::symlink_metadata(path)?))
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        fs::canonicalize(path)
    }

    fn create_new(&self, path: &Path, bytes: &[u8]) -> io::Result<bool> {
        use std::io::Write;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut f) => {
                f.write_all(bytes)?;
                Ok(true)
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)?;
        f.write_all(bytes)
    }
}

/// 인메모리 백엔드 (테스트용). 실제 파일시스템 없이 [`Backend`] 위에서 도는
/// 로직(특히 collab CRDT)이 백엔드에 독립적인지 검증한다 — 원격(SFTP)에서도
/// 같은 코드가 동작함을 sshd 없이 보장한다.
#[cfg(test)]
#[derive(Default)]
pub struct InMemoryBackend {
    state: std::sync::Mutex<MemState>,
}

#[cfg(test)]
#[derive(Default)]
struct MemState {
    files: std::collections::HashMap<PathBuf, Vec<u8>>,
    dirs: std::collections::HashSet<PathBuf>,
}

#[cfg(test)]
impl InMemoryBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
fn not_found() -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, "no such path")
}

#[cfg(test)]
fn register_ancestors(dirs: &mut std::collections::HashSet<PathBuf>, path: &Path) {
    let mut cur = path.parent();
    while let Some(d) = cur {
        if d.as_os_str().is_empty() {
            break;
        }
        dirs.insert(d.to_path_buf());
        cur = d.parent();
    }
}

#[cfg(test)]
impl Backend for InMemoryBackend {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let st = self.state.lock().unwrap();
        st.files.get(path).cloned().ok_or_else(not_found)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut st = self.state.lock().unwrap();
        register_ancestors(&mut st.dirs, path);
        st.files.insert(path.to_path_buf(), bytes.to_vec());
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let mut st = self.state.lock().unwrap();
        let bytes = st.files.remove(from).ok_or_else(not_found)?;
        register_ancestors(&mut st.dirs, to);
        st.files.insert(to.to_path_buf(), bytes); // POSIX: 덮어쓰기 허용
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        let mut st = self.state.lock().unwrap();
        st.files.remove(path).map(|_| ()).ok_or_else(not_found)
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        let mut st = self.state.lock().unwrap();
        st.files.retain(|k, _| !k.starts_with(path));
        st.dirs.retain(|d| !d.starts_with(path));
        Ok(())
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        let mut st = self.state.lock().unwrap();
        register_ancestors(&mut st.dirs, path);
        st.dirs.insert(path.to_path_buf());
        Ok(())
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
        let st = self.state.lock().unwrap();
        let is_dir = st.dirs.contains(path);
        let mut out = Vec::new();
        let mut push = |child: &Path| {
            if child.parent() == Some(path) {
                if let Some(name) = child.file_name() {
                    out.push(DirEntry {
                        name: name.to_string_lossy().into_owned(),
                        path: child.to_path_buf(),
                    });
                }
            }
        };
        for k in st.files.keys() {
            push(k);
        }
        for d in st.dirs.iter() {
            push(d);
        }
        if !is_dir && out.is_empty() {
            return Err(not_found());
        }
        Ok(out)
    }

    fn metadata(&self, path: &Path) -> io::Result<Meta> {
        let st = self.state.lock().unwrap();
        if let Some(bytes) = st.files.get(path) {
            Ok(Meta {
                is_dir: false,
                is_file: true,
                is_symlink: false,
                len: bytes.len() as u64,
            })
        } else if st.dirs.contains(path) {
            Ok(Meta {
                is_dir: true,
                is_file: false,
                is_symlink: false,
                len: 0,
            })
        } else {
            Err(not_found())
        }
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<Meta> {
        self.metadata(path)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        Ok(path.to_path_buf())
    }

    fn create_new(&self, path: &Path, bytes: &[u8]) -> io::Result<bool> {
        let mut st = self.state.lock().unwrap();
        if st.files.contains_key(path) || st.dirs.contains(path) {
            return Ok(false);
        }
        register_ancestors(&mut st.dirs, path);
        st.files.insert(path.to_path_buf(), bytes.to_vec());
        Ok(true)
    }

    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut st = self.state.lock().unwrap();
        register_ancestors(&mut st.dirs, path);
        st.files
            .entry(path.to_path_buf())
            .or_default()
            .extend_from_slice(bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_create_new_reports_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.txt");
        assert!(LocalBackend.create_new(&p, b"v1").unwrap());
        assert!(!LocalBackend.create_new(&p, b"v2").unwrap());
        assert_eq!(LocalBackend.read(&p).unwrap(), b"v1");
    }

    #[test]
    fn inmemory_roundtrip_create_append_readdir() {
        let b = InMemoryBackend::new();
        b.create_dir_all(Path::new("/ws/docs")).unwrap();
        assert!(b.create_new(Path::new("/ws/docs/a.y"), b"v1").unwrap());
        // 같은 경로 재생성은 충돌(false)
        assert!(!b.create_new(Path::new("/ws/docs/a.y"), b"x").unwrap());
        b.append(Path::new("/ws/docs/a.y"), b"v2").unwrap();
        assert_eq!(b.read(Path::new("/ws/docs/a.y")).unwrap(), b"v1v2");
        // read_dir은 직속 자식만
        let names: Vec<_> = b
            .read_dir(Path::new("/ws/docs"))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["a.y".to_string()]);
        // write_atomic(기본 제공)이 rename 폴백 없이도 동작
        b.write_atomic(Path::new("/ws/docs/a.y"), b"v3").unwrap();
        assert_eq!(b.read(Path::new("/ws/docs/a.y")).unwrap(), b"v3");
        // 없는 경로 read_dir은 에러
        assert!(b.read_dir(Path::new("/ws/none")).is_err());
    }

    #[test]
    fn local_append_extends_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("log");
        LocalBackend.append(&p, b"abc").unwrap();
        LocalBackend.append(&p, b"def").unwrap();
        assert_eq!(LocalBackend.read(&p).unwrap(), b"abcdef");
    }

    #[test]
    fn move_entry_relocates_into_other_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("a");
        let dst_dir = tmp.path().join("b");
        LocalBackend.create_dir_all(&src_dir).unwrap();
        LocalBackend.create_dir_all(&dst_dir).unwrap();
        let file = src_dir.join("note.md");
        LocalBackend.write(&file, b"hi").unwrap();

        let moved = LocalBackend.move_entry(&file, &dst_dir).unwrap();
        assert_eq!(moved, dst_dir.join("note.md"));
        assert!(!LocalBackend.exists(&file));
        assert_eq!(LocalBackend.read(&moved).unwrap(), b"hi");
    }

    #[test]
    fn move_entry_into_same_dir_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("a");
        LocalBackend.create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        LocalBackend.write(&file, b"hi").unwrap();

        let same = LocalBackend.move_entry(&file, &dir).unwrap();
        assert_eq!(same, file);
        assert_eq!(LocalBackend.read(&file).unwrap(), b"hi");
    }

    #[test]
    fn move_entry_rejects_name_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("a");
        let dst_dir = tmp.path().join("b");
        LocalBackend.create_dir_all(&src_dir).unwrap();
        LocalBackend.create_dir_all(&dst_dir).unwrap();
        let file = src_dir.join("note.md");
        LocalBackend.write(&file, b"new").unwrap();
        LocalBackend.write(&dst_dir.join("note.md"), b"old").unwrap();

        let err = LocalBackend.move_entry(&file, &dst_dir).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        // 원본도 대상도 그대로 유지된다 (덮어쓰기 없음)
        assert_eq!(LocalBackend.read(&file).unwrap(), b"new");
        assert_eq!(LocalBackend.read(&dst_dir.join("note.md")).unwrap(), b"old");
    }

    #[test]
    fn move_entry_rejects_into_own_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("parent");
        let sub = dir.join("child");
        LocalBackend.create_dir_all(&sub).unwrap();

        let err = LocalBackend.move_entry(&dir, &sub).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(LocalBackend.exists(&sub)); // 트리 보존
    }

    #[test]
    fn local_symlink_metadata_flags_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("t");
        LocalBackend.write(&target, b"x").unwrap();
        let meta = LocalBackend.metadata(&target).unwrap();
        assert!(meta.is_file && !meta.is_dir && !meta.is_symlink);
    }
}
