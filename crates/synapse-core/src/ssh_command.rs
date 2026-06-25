//! `ssh ...` 명령줄 파싱 (GUI 비의존, 순수 함수).
//!
//! 사용자가 붙여넣은 `ssh user@host -p 2222 -i ~/.ssh/key` 같은 한 줄을
//! 접속에 필요한 요소로 분해한다. `~/.ssh/config` 별칭 해소는
//! [`crate::ssh_config`]가 맡고, 둘을 합쳐 최종 접속 대상을 만드는 일은
//! Tauri 셸(`src-tauri`)에서 한다 — 여기서는 파일 IO 없이 문자열만 다룬다.

use std::fmt;

/// `ssh` 명령줄에서 뽑아낸 접속 요소. 값은 명령줄에 **명시된 것만** 채운다
/// (기본값/`~/.ssh/config` 병합은 호출자 몫).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SshInvocation {
    /// `-l user` 또는 `user@host` 또는 `-o User=` 로 지정한 사용자.
    pub user: Option<String>,
    /// 위치 인자의 호스트(또는 `~/.ssh/config` 별칭). 항상 채워진다.
    pub host: String,
    /// `-p` 또는 `-o Port=` 로 지정한 포트.
    pub port: Option<u16>,
    /// `-i` 또는 `-o IdentityFile=` 로 지정한 키 경로(틸드 미확장).
    pub identity_file: Option<String>,
    /// `-o HostName=` 로 지정한 실제 호스트명(별칭 대신 직접 지정한 경우).
    pub host_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshCommandError {
    /// 호스트를 찾지 못했다(빈 입력 등).
    MissingHost,
    /// 옵션에 값이 빠졌다(예: 끝에 홀로 있는 `-p`).
    MissingValue(String),
    /// 포트가 숫자가 아니거나 범위를 벗어났다.
    InvalidPort(String),
}

impl fmt::Display for SshCommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SshCommandError::MissingHost => write!(f, "ssh 명령에서 호스트를 찾을 수 없습니다"),
            SshCommandError::MissingValue(opt) => write!(f, "{opt} 옵션에 값이 없습니다"),
            SshCommandError::InvalidPort(p) => write!(f, "잘못된 포트: {p}"),
        }
    }
}

impl std::error::Error for SshCommandError {}

/// `-o Key=Value` 처럼 인자를 하나 받는 단문자 옵션들.
/// 호스트를 값으로 오인하지 않도록 인자 소비 여부를 정확히 알아야 한다.
/// (모르는 단문자 옵션은 인자 없는 플래그로 간주한다.)
fn takes_arg(flag: char) -> bool {
    matches!(
        flag,
        'p' | 'i'
            | 'l'
            | 'o'
            | 'J'
            | 'F'
            | 'b'
            | 'c'
            | 'D'
            | 'E'
            | 'I'
            | 'L'
            | 'm'
            | 'O'
            | 'Q'
            | 'R'
            | 'S'
            | 'W'
            | 'w'
    )
}

/// `ssh [옵션] [user@]host [원격커맨드...]` 한 줄을 파싱한다.
/// 선행 `ssh` 토큰은 있으면 버린다. 호스트 뒤의 토큰(원격 커맨드)은 무시한다.
pub fn parse_ssh_command(input: &str) -> Result<SshInvocation, SshCommandError> {
    let tokens = tokenize(input);
    let mut it = tokens.into_iter().peekable();

    // 선행 "ssh" 한 번만 제거(경로 `/usr/bin/ssh` 포함 형태도 처리).
    if let Some(first) = it.peek() {
        let base = first.rsplit('/').next().unwrap_or(first);
        if base == "ssh" {
            it.next();
        }
    }

    let mut inv = SshInvocation::default();
    let mut host: Option<String> = None;

    while let Some(tok) = it.next() {
        if host.is_some() {
            // 호스트를 이미 잡았으면 나머지는 원격 커맨드 — 무시.
            break;
        }
        if let Some(rest) = tok.strip_prefix('-') {
            if rest.is_empty() {
                continue; // 외톨이 "-"
            }
            let flag = rest.chars().next().unwrap();
            // 인자값: 붙은 형태(`-p2222`) 우선, 아니면 다음 토큰.
            if takes_arg(flag) {
                let attached = &rest[flag.len_utf8()..];
                let value = if !attached.is_empty() {
                    attached.to_string()
                } else {
                    it.next()
                        .ok_or_else(|| SshCommandError::MissingValue(format!("-{flag}")))?
                };
                apply_option(flag, &value, &mut inv)?;
            }
            // 인자 없는 플래그(-v, -A, -4 등)는 그냥 스킵.
            continue;
        }
        // 위치 인자 = 호스트(또는 user@host / 별칭).
        host = Some(tok);
    }

    let host = host.ok_or(SshCommandError::MissingHost)?;
    // `user@host` 의 user 는 명령줄에서 가장 우선(있으면 -l/-o 덮어씀).
    if let Some((u, h)) = host.rsplit_once('@') {
        if !u.is_empty() {
            inv.user = Some(u.to_string());
        }
        inv.host = h.to_string();
    } else {
        inv.host = host;
    }

    if inv.host.is_empty() {
        return Err(SshCommandError::MissingHost);
    }
    Ok(inv)
}

/// 인자 받는 단문자 옵션 적용. 모르는 옵션값은 조용히 버린다.
fn apply_option(flag: char, value: &str, inv: &mut SshInvocation) -> Result<(), SshCommandError> {
    match flag {
        'p' => inv.port = Some(parse_port(value)?),
        'i' => inv.identity_file = Some(value.to_string()),
        'l' => inv.user = Some(value.to_string()),
        'o' => apply_o_option(value, inv)?,
        _ => {} // -J/-F/... 등은 무시
    }
    Ok(())
}

/// `-o Key=Value` 중 우리가 쓰는 키만 반영한다(키 대소문자 무시).
fn apply_o_option(value: &str, inv: &mut SshInvocation) -> Result<(), SshCommandError> {
    let Some((key, val)) = value.split_once('=') else {
        return Ok(()); // `-o Foo` 같은 비정상 형태는 무시
    };
    let val = val.trim();
    match key.trim().to_ascii_lowercase().as_str() {
        "port" => inv.port = Some(parse_port(val)?),
        "user" => inv.user = Some(val.to_string()),
        "identityfile" => inv.identity_file = Some(val.to_string()),
        "hostname" => inv.host_name = Some(val.to_string()),
        _ => {}
    }
    Ok(())
}

fn parse_port(s: &str) -> Result<u16, SshCommandError> {
    s.trim()
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| SshCommandError::InvalidPort(s.to_string()))
}

/// 아주 작은 셸식 토크나이저: 공백 분리 + `'...'`/`"..."` 인용 + `\` 이스케이프.
/// (ProxyCommand 같은 복잡한 인용은 범위 밖 — 흔한 붙여넣기만 처리한다.)
fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = input.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_tok = false;

    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                has_tok = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_tok = true;
            }
            '\\' if !in_single => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                    has_tok = true;
                }
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_tok {
                    out.push(std::mem::take(&mut cur));
                    has_tok = false;
                }
            }
            c => {
                cur.push(c);
                has_tok = true;
            }
        }
    }
    if has_tok {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> SshInvocation {
        parse_ssh_command(s).unwrap()
    }

    #[test]
    fn bare_host() {
        let inv = parse("ssh example.com");
        assert_eq!(inv.host, "example.com");
        assert_eq!(inv.user, None);
        assert_eq!(inv.port, None);
    }

    #[test]
    fn user_at_host() {
        let inv = parse("ssh jaebin@example.com");
        assert_eq!(inv.host, "example.com");
        assert_eq!(inv.user.as_deref(), Some("jaebin"));
    }

    #[test]
    fn without_leading_ssh() {
        let inv = parse("jaebin@example.com");
        assert_eq!(inv.host, "example.com");
        assert_eq!(inv.user.as_deref(), Some("jaebin"));
    }

    #[test]
    fn port_and_identity() {
        let inv = parse("ssh -p 2222 -i ~/.ssh/id_ed25519 jaebin@example.com");
        assert_eq!(inv.port, Some(2222));
        assert_eq!(inv.identity_file.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(inv.user.as_deref(), Some("jaebin"));
        assert_eq!(inv.host, "example.com");
    }

    #[test]
    fn attached_option_value() {
        let inv = parse("ssh -p2222 example.com");
        assert_eq!(inv.port, Some(2222));
        assert_eq!(inv.host, "example.com");
    }

    #[test]
    fn login_flag() {
        let inv = parse("ssh -l jaebin example.com");
        assert_eq!(inv.user.as_deref(), Some("jaebin"));
        assert_eq!(inv.host, "example.com");
    }

    #[test]
    fn user_at_host_overrides_login_flag() {
        // 명령줄의 user@host 가 -l 보다 우선.
        let inv = parse("ssh -l other jaebin@example.com");
        assert_eq!(inv.user.as_deref(), Some("jaebin"));
    }

    #[test]
    fn dash_o_options() {
        let inv = parse("ssh -o Port=2200 -o User=root -o IdentityFile=~/.ssh/k example.com");
        assert_eq!(inv.port, Some(2200));
        assert_eq!(inv.user.as_deref(), Some("root"));
        assert_eq!(inv.identity_file.as_deref(), Some("~/.ssh/k"));
    }

    #[test]
    fn dash_o_hostname() {
        let inv = parse("ssh -o HostName=10.0.0.5 myalias");
        assert_eq!(inv.host, "myalias");
        assert_eq!(inv.host_name.as_deref(), Some("10.0.0.5"));
    }

    #[test]
    fn ignores_trailing_remote_command() {
        let inv = parse("ssh jaebin@example.com ls -la /tmp");
        assert_eq!(inv.host, "example.com");
        // -la /tmp 는 원격 커맨드 — 우리 옵션으로 새지 않는다.
        assert_eq!(inv.identity_file, None);
    }

    #[test]
    fn skips_flag_without_arg() {
        let inv = parse("ssh -v -A -4 jaebin@example.com");
        assert_eq!(inv.host, "example.com");
        assert_eq!(inv.user.as_deref(), Some("jaebin"));
    }

    #[test]
    fn quoted_identity_path() {
        let inv = parse("ssh -i \"/home/me/my key\" example.com");
        assert_eq!(inv.identity_file.as_deref(), Some("/home/me/my key"));
        assert_eq!(inv.host, "example.com");
    }

    #[test]
    fn alias_only() {
        let inv = parse("ssh myserver");
        assert_eq!(inv.host, "myserver");
        assert_eq!(inv.user, None);
        assert_eq!(inv.port, None);
    }

    #[test]
    fn empty_input_errors() {
        assert_eq!(parse_ssh_command("ssh"), Err(SshCommandError::MissingHost));
        assert_eq!(parse_ssh_command(""), Err(SshCommandError::MissingHost));
        assert_eq!(parse_ssh_command("   "), Err(SshCommandError::MissingHost));
    }

    #[test]
    fn missing_option_value_errors() {
        assert_eq!(
            parse_ssh_command("ssh -p"),
            Err(SshCommandError::MissingValue("-p".to_string()))
        );
    }

    #[test]
    fn invalid_port_errors() {
        assert!(matches!(
            parse_ssh_command("ssh -p abc example.com"),
            Err(SshCommandError::InvalidPort(_))
        ));
        assert!(matches!(
            parse_ssh_command("ssh -p 0 example.com"),
            Err(SshCommandError::InvalidPort(_))
        ));
    }
}
