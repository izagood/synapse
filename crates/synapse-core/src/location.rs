//! 워크스페이스 위치 식별자.
//!
//! 로컬 폴더는 기존처럼 OS 절대경로 문자열로, 원격 SSH 폴더는
//! `ssh://user@host[:port]/abs/path` URI로 표현한다. 프론트엔드에서 넘어오는
//! `root`/`path` 문자열은 모두 [`Location::parse`]로 해석한다(스킴이 없으면
//! 로컬 경로로 간주 — 하위호환).

use std::fmt;
use std::path::PathBuf;

/// SSH 원격 위치: `ssh://user@host:port/path`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshLocation {
    pub user: String,
    pub host: String,
    pub port: u16,
    /// POSIX 절대경로. 빈 문자열이면 원격 홈 디렉토리(연결 시 realpath로 해소).
    pub path: String,
}

/// 워크스페이스(또는 그 안의 파일) 위치.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Local(PathBuf),
    Ssh(SshLocation),
}

/// SSH 기본 포트.
pub const DEFAULT_SSH_PORT: u16 = 22;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocationError {
    MissingUser,
    MissingHost,
    InvalidPort(String),
}

impl fmt::Display for LocationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocationError::MissingUser => write!(f, "ssh URI에 사용자(user@)가 없습니다"),
            LocationError::MissingHost => write!(f, "ssh URI에 호스트가 없습니다"),
            LocationError::InvalidPort(p) => write!(f, "잘못된 포트: {p}"),
        }
    }
}

impl std::error::Error for LocationError {}

impl Location {
    /// 위치 문자열을 해석한다. `ssh://`로 시작하면 원격, 아니면 로컬 경로.
    pub fn parse(s: &str) -> Result<Location, LocationError> {
        match s.strip_prefix("ssh://") {
            Some(rest) => Ok(Location::Ssh(parse_ssh(rest)?)),
            None => Ok(Location::Local(PathBuf::from(s))),
        }
    }

    /// 원격이면 true.
    pub fn is_remote(&self) -> bool {
        matches!(self, Location::Ssh(_))
    }

    /// 직렬화 문자열(파싱의 역연산). registry/세션 저장·FileNode.path에 쓴다.
    pub fn to_uri(&self) -> String {
        match self {
            Location::Local(p) => p.to_string_lossy().into_owned(),
            Location::Ssh(s) => {
                let mut out = format!("ssh://{}@{}", s.user, format_host(&s.host));
                if s.port != DEFAULT_SSH_PORT {
                    out.push_str(&format!(":{}", s.port));
                }
                out.push_str(&s.path);
                out
            }
        }
    }

    /// 이 위치 아래의 자식 경로(한 단계 이름)를 만든다.
    pub fn child(&self, name: &str) -> Location {
        match self {
            Location::Local(p) => Location::Local(p.join(name)),
            Location::Ssh(s) => {
                let mut child = s.clone();
                child.path = join_posix(&s.path, name);
                Location::Ssh(child)
            }
        }
    }
}

impl fmt::Display for Location {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_uri())
    }
}

/// IPv6 리터럴 호스트는 대괄호로 감싼다.
fn format_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// POSIX 경로에 한 세그먼트를 잇는다(항상 `/` 구분).
fn join_posix(base: &str, name: &str) -> String {
    if base.is_empty() {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// `ssh://` 이후 부분(`[user@]host[:port][/path]`)을 해석한다.
fn parse_ssh(rest: &str) -> Result<SshLocation, LocationError> {
    // authority 와 path 를 첫 '/'에서 가른다 (path는 선행 '/'를 포함).
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, String::new()),
    };

    // user@hostport
    let (user, hostport) = match authority.split_once('@') {
        Some((u, hp)) if !u.is_empty() => (u.to_string(), hp),
        Some(_) => return Err(LocationError::MissingUser),
        None => return Err(LocationError::MissingUser),
    };

    let (host, port) = split_host_port(hostport)?;
    if host.is_empty() {
        return Err(LocationError::MissingHost);
    }

    Ok(SshLocation {
        user,
        host,
        port,
        path,
    })
}

/// `host`, `host:port`, `[ipv6]`, `[ipv6]:port` 를 (host, port)로 가른다.
fn split_host_port(hp: &str) -> Result<(String, u16), LocationError> {
    if let Some(after) = hp.strip_prefix('[') {
        // 대괄호 IPv6: [addr] 또는 [addr]:port
        let (addr, tail) = after
            .split_once(']')
            .ok_or_else(|| LocationError::InvalidPort(hp.to_string()))?;
        let port = match tail.strip_prefix(':') {
            Some(p) => parse_port(p)?,
            None if tail.is_empty() => DEFAULT_SSH_PORT,
            None => return Err(LocationError::InvalidPort(tail.to_string())),
        };
        Ok((addr.to_string(), port))
    } else {
        match hp.rsplit_once(':') {
            Some((h, p)) => Ok((h.to_string(), parse_port(p)?)),
            None => Ok((hp.to_string(), DEFAULT_SSH_PORT)),
        }
    }
}

fn parse_port(p: &str) -> Result<u16, LocationError> {
    p.parse::<u16>()
        .map_err(|_| LocationError::InvalidPort(p.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_path_without_scheme() {
        let loc = Location::parse("/home/me/notes").unwrap();
        assert_eq!(loc, Location::Local(PathBuf::from("/home/me/notes")));
        assert!(!loc.is_remote());
        assert_eq!(loc.to_uri(), "/home/me/notes");
    }

    #[test]
    fn parses_full_ssh_uri() {
        let loc = Location::parse("ssh://me@host.example:2222/srv/notes").unwrap();
        let Location::Ssh(s) = &loc else {
            panic!("expected ssh")
        };
        assert_eq!(s.user, "me");
        assert_eq!(s.host, "host.example");
        assert_eq!(s.port, 2222);
        assert_eq!(s.path, "/srv/notes");
        assert!(loc.is_remote());
    }

    #[test]
    fn defaults_port_22_and_omits_in_uri() {
        let loc = Location::parse("ssh://me@host/notes").unwrap();
        let Location::Ssh(s) = &loc else { panic!() };
        assert_eq!(s.port, 22);
        // 기본 포트는 round-trip 시 생략된다
        assert_eq!(loc.to_uri(), "ssh://me@host/notes");
    }

    #[test]
    fn roundtrips_non_default_port() {
        let uri = "ssh://me@host:2222/srv/notes";
        assert_eq!(Location::parse(uri).unwrap().to_uri(), uri);
    }

    #[test]
    fn empty_path_means_home() {
        let loc = Location::parse("ssh://me@host").unwrap();
        let Location::Ssh(s) = &loc else { panic!() };
        assert_eq!(s.path, "");
        assert_eq!(loc.to_uri(), "ssh://me@host");
    }

    #[test]
    fn parses_bracketed_ipv6() {
        let loc = Location::parse("ssh://me@[2001:db8::1]:22/notes").unwrap();
        let Location::Ssh(s) = &loc else { panic!() };
        assert_eq!(s.host, "2001:db8::1");
        assert_eq!(s.port, 22);
        // round-trip: 기본 포트 생략 + IPv6 대괄호 복원
        assert_eq!(loc.to_uri(), "ssh://me@[2001:db8::1]/notes");
    }

    #[test]
    fn rejects_missing_user_and_host() {
        assert_eq!(
            Location::parse("ssh://host/notes"),
            Err(LocationError::MissingUser)
        );
        assert_eq!(
            Location::parse("ssh://@host/notes"),
            Err(LocationError::MissingUser)
        );
    }

    #[test]
    fn rejects_bad_port() {
        assert!(matches!(
            Location::parse("ssh://me@host:notaport/x"),
            Err(LocationError::InvalidPort(_))
        ));
    }

    #[test]
    fn child_joins_local_and_remote() {
        let local = Location::parse("/root").unwrap().child("sub");
        assert_eq!(local, Location::Local(PathBuf::from("/root/sub")));

        let remote = Location::parse("ssh://me@host/srv")
            .unwrap()
            .child("note.md");
        assert_eq!(remote.to_uri(), "ssh://me@host/srv/note.md");

        // 홈(빈 경로)에서의 자식은 절대경로가 된다
        let home_child = Location::parse("ssh://me@host").unwrap().child("notes");
        assert_eq!(home_child.to_uri(), "ssh://me@host/notes");
    }
}
