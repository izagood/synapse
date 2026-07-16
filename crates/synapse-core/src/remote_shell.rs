//! 원격(ssh://) 워크스페이스에서 "그 디렉토리로 이동한 원격 셸"을 여는
//! 시스템 ssh 클라이언트 인자 조립(순수). 실행은 호출 측(내장 PTY·외부 터미널)이 한다.
//!
//! 앱 내부 인증(russh)과 달리 시스템 `ssh`를 쓴다 — 에이전트·기본 키·
//! ~/.ssh/config를 그대로 활용하고, 앱이 호스트키를 학습하는 파일과 동일한
//! ~/.ssh/known_hosts를 보므로 이미 승인한 호스트는 재확인이 없다.

use crate::location::SshLocation;
use crate::ssh::sh_single_quote;

/// `ssh -t`로 원격 디렉토리에 cd 후 로그인 셸을 exec하는 argv.
/// `"$SHELL"`은 원격에서 평가돼야 하므로 문자열 그대로 전달한다(로컬 확장 없음).
pub fn ssh_shell_argv(loc: &SshLocation, key_path: Option<&str>) -> Vec<String> {
    let mut argv: Vec<String> = vec!["ssh".into(), "-t".into(), "-p".into(), loc.port.to_string()];
    if let Some(key) = key_path.map(str::trim).filter(|k| !k.is_empty()) {
        argv.push("-i".into());
        argv.push(key.into());
    }
    argv.push(format!("{}@{}", loc.user, loc.host));
    // 경로가 비면(이론상 연결 시 홈으로 해소되지만 방어) 인자 없는 cd == 홈 이동.
    let cd = if loc.path.is_empty() {
        "cd".to_string()
    } else {
        format!("cd {}", sh_single_quote(&loc.path))
    };
    argv.push(format!("{cd} && exec \"$SHELL\" -l"));
    argv
}

/// argv를 POSIX 셸에서 안전한 한 줄 명령으로 합친다(외부 터미널의 -e 인자용).
pub fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            let safe = !a.is_empty()
                && a.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c));
            if safe {
                a.clone()
            } else {
                sh_single_quote(a)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(path: &str) -> SshLocation {
        SshLocation {
            user: "me".into(),
            host: "hosta".into(),
            port: 22,
            path: path.into(),
        }
    }

    #[test]
    fn argv_basic_cd_and_login_shell() {
        let argv = ssh_shell_argv(&loc("/ws/notes"), None);
        assert_eq!(
            argv,
            vec![
                "ssh",
                "-t",
                "-p",
                "22",
                "me@hosta",
                "cd '/ws/notes' && exec \"$SHELL\" -l",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn argv_includes_identity_file_when_given() {
        let argv = ssh_shell_argv(&loc("/ws"), Some("/home/me/.ssh/k"));
        let i = argv.iter().position(|a| a == "-i").expect("-i 플래그");
        assert_eq!(argv[i + 1], "/home/me/.ssh/k");
    }

    #[test]
    fn argv_ignores_blank_key_path() {
        let argv = ssh_shell_argv(&loc("/ws"), Some("  "));
        assert!(!argv.iter().any(|a| a == "-i"));
    }

    #[test]
    fn argv_nondefault_port() {
        let argv = ssh_shell_argv(
            &SshLocation {
                user: "u".into(),
                host: "h".into(),
                port: 2222,
                path: "/d".into(),
            },
            None,
        );
        let p = argv.iter().position(|a| a == "-p").unwrap();
        assert_eq!(argv[p + 1], "2222");
    }

    #[test]
    fn argv_quotes_single_quote_in_path() {
        let argv = ssh_shell_argv(&loc("/a'b"), None);
        // sh_single_quote 규칙: ' → '\''
        assert!(argv.last().unwrap().contains(r#"cd '/a'\''b'"#));
    }

    #[test]
    fn argv_empty_path_goes_home() {
        let argv = ssh_shell_argv(&loc(""), None);
        assert_eq!(argv.last().unwrap(), "cd && exec \"$SHELL\" -l");
    }

    #[test]
    fn shell_join_quotes_only_when_needed() {
        let joined = shell_join(&[
            "ssh".into(),
            "-p".into(),
            "22".into(),
            "me@hosta".into(),
            "cd '/ws' && exec \"$SHELL\" -l".into(),
        ]);
        assert_eq!(
            joined,
            r#"ssh -p 22 me@hosta 'cd '\''/ws'\'' && exec "$SHELL" -l'"#
        );
    }
}
