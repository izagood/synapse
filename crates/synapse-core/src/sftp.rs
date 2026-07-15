//! 원격 SFTP 파일시스템 백엔드 ([`crate::vfs::Backend`] 구현).
//!
//! [`crate::ssh::SshSession`]을 감싸 모든 파일 연산을 SFTP로 라우팅한다.
//! synapse-core는 동기이므로 async russh-sftp 호출은 core 전용 런타임에서
//! `block_on`으로 처리한다([`crate::ssh::runtime`]). 이 백엔드 메서드들은
//! Tauri의 `spawn_blocking` 스레드풀에서 호출되어 UI를 막지 않는다.
//!
//! 경로는 [`Path`]에 담긴 POSIX 문자열로 다룬다(원격은 항상 `/` 구분). 호스트가
//! POSIX(macOS/Linux)일 때 [`Path`]의 join/parent 의미가 원격과 일치한다.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::protocol::OpenFlags;
use tokio::io::AsyncWriteExt;

use crate::ssh::{runtime, SshSession};
use crate::vfs::{Backend, DirEntry, Meta};

/// 원격 SSH 워크스페이스의 파일시스템 백엔드.
#[derive(Clone)]
pub struct SftpBackend {
    session: Arc<SshSession>,
}

impl SftpBackend {
    pub fn new(session: Arc<SshSession>) -> Self {
        SftpBackend { session }
    }

    fn sftp(&self) -> &russh_sftp::client::SftpSession {
        self.session.sftp()
    }
}

/// [`Path`] → 원격 POSIX 경로 문자열.
fn posix(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::other(e.to_string())
}

fn meta_from(m: &russh_sftp::protocol::FileAttributes) -> Meta {
    Meta {
        is_dir: m.is_dir(),
        is_file: m.is_regular(),
        is_symlink: m.is_symlink(),
        len: m.len(),
    }
}

impl Backend for SftpBackend {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        runtime().block_on(async { self.sftp().read(posix(path)).await.map_err(to_io) })
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        // russh-sftp의 write() 헬퍼는 WRITE 플래그만으로 열어 새 파일을 만들지
        // 못하고(No such file), 기존 파일도 truncate 없이 덮어써 새 내용이 더
        // 짧으면 꼬리가 남는다. CREATE|TRUNCATE|WRITE로 여는 create()를 쓴다.
        let target = posix(path);
        runtime().block_on(async {
            let mut file = self.sftp().create(target).await.map_err(to_io)?;
            file.write_all(bytes).await.map_err(to_io)?;
            file.shutdown().await.map_err(to_io)?;
            Ok(())
        })
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        runtime().block_on(async {
            self.sftp()
                .rename(posix(from), posix(to))
                .await
                .map_err(to_io)
        })
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        runtime().block_on(async { self.sftp().remove_file(posix(path)).await.map_err(to_io) })
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        runtime().block_on(async { remove_dir_all_async(self.sftp(), posix(path)).await })
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        let target = posix(path);
        runtime().block_on(async {
            let sftp = self.sftp();
            let mut cur = if target.starts_with('/') {
                String::new()
            } else {
                String::from(".")
            };
            for comp in target.split('/').filter(|c| !c.is_empty()) {
                cur = format!("{cur}/{comp}");
                // 이미 있으면 무시; 마지막에 대상 존재 여부로 성패를 판정한다.
                let _ = sftp.create_dir(cur.clone()).await;
            }
            if sftp.try_exists(target).await.map_err(to_io)? {
                Ok(())
            } else {
                Err(io::Error::other(
                    "create_dir_all: 디렉토리를 만들지 못했습니다",
                ))
            }
        })
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
        runtime().block_on(async {
            let entries = self.sftp().read_dir(posix(path)).await.map_err(to_io)?;
            Ok(entries
                .map(|e| DirEntry {
                    name: e.file_name(),
                    path: PathBuf::from(e.path()),
                })
                .collect())
        })
    }

    fn metadata(&self, path: &Path) -> io::Result<Meta> {
        runtime().block_on(async {
            self.sftp()
                .metadata(posix(path))
                .await
                .map(|m| meta_from(&m))
                .map_err(to_io)
        })
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<Meta> {
        runtime().block_on(async {
            self.sftp()
                .symlink_metadata(posix(path))
                .await
                .map(|m| meta_from(&m))
                .map_err(to_io)
        })
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        runtime().block_on(async {
            self.sftp()
                .canonicalize(posix(path))
                .await
                .map(PathBuf::from)
                .map_err(to_io)
        })
    }

    fn create_new(&self, path: &Path, bytes: &[u8]) -> io::Result<bool> {
        let target = posix(path);
        runtime().block_on(async {
            let sftp = self.sftp();
            // SFTPv3는 EEXIST를 명확히 구분하지 않으므로 존재 검사로 충돌을 판정한다.
            if sftp.try_exists(target.clone()).await.map_err(to_io)? {
                return Ok(false);
            }
            let mut file = sftp
                .open_with_flags(
                    target,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
                )
                .await
                .map_err(to_io)?;
            file.write_all(bytes).await.map_err(to_io)?;
            file.shutdown().await.map_err(to_io)?;
            Ok(true)
        })
    }

    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let target = posix(path);
        runtime().block_on(async {
            let mut file = self
                .sftp()
                .open_with_flags(
                    target,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::APPEND,
                )
                .await
                .map_err(to_io)?;
            file.write_all(bytes).await.map_err(to_io)?;
            file.shutdown().await.map_err(to_io)?;
            Ok(())
        })
    }

    /// SFTP의 rename은 POSIX가 아니어서 대상이 존재하면 실패할 수 있다. 그래서
    /// 기본 구현(tmp→rename) 대신, 충돌 시 대상을 지우고 다시 rename 한다.
    /// 이 폴백 구간에서는 원자성이 약화된다(SFTP 한계).
    fn write_atomic(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
        })?;
        let file_name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
            .to_string_lossy();
        let tmp = posix(&parent.join(format!(".{file_name}.synapse-tmp")));
        let dst = posix(path);
        runtime().block_on(async {
            let sftp = self.sftp();
            // tmp는 항상 새 파일이므로 CREATE가 필요하다(create = CREATE|TRUNCATE|WRITE).
            // sftp.write()는 WRITE만으로 열어 새 파일에서 No such file로 실패한다.
            let mut file = sftp.create(tmp.clone()).await.map_err(to_io)?;
            file.write_all(content).await.map_err(to_io)?;
            file.shutdown().await.map_err(to_io)?;
            if sftp.rename(tmp.clone(), dst.clone()).await.is_err() {
                let _ = sftp.remove_file(dst.clone()).await;
                if let Err(e) = sftp.rename(tmp.clone(), dst).await {
                    let _ = sftp.remove_file(tmp).await;
                    return Err(to_io(e));
                }
            }
            Ok(())
        })
    }
}

/// 디렉토리를 재귀적으로 지운다(SFTP remove_dir는 빈 디렉토리만 지우므로).
fn remove_dir_all_async<'a>(
    sftp: &'a russh_sftp::client::SftpSession,
    path: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let entries = sftp.read_dir(path.clone()).await.map_err(to_io)?;
        for entry in entries {
            let child = entry.path();
            if entry.file_type().is_dir() {
                remove_dir_all_async(sftp, child).await?;
            } else {
                sftp.remove_file(child).await.map_err(to_io)?;
            }
        }
        sftp.remove_dir(path).await.map_err(to_io)
    })
}
