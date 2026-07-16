//! 외부 OS 터미널 실행 명령 조립(순수). 실제 spawn·존재 탐지는 src-tauri가 한다.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
}

fn launch(program: &str, args: &[&str]) -> Launch {
    Launch {
        program: program.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// 커스텀 명령 템플릿: 공백 분할 후 각 토큰의 `{{cwd}}`를 치환한다.
/// 템플릿에 `{{cwd}}`가 없으면 cwd를 마지막 인자로 덧붙인다.
/// (v1 제약: 따옴표로 묶인 인자는 지원하지 않는다 — 단순 공백 분할.)
fn custom_launch(custom: &str, cwd: &str) -> Result<Launch, String> {
    let parts: Vec<&str> = custom.split_whitespace().collect();
    let (prog, rest) = parts.split_first().ok_or("빈 커스텀 터미널 명령")?;
    let had_token = custom.contains("{{cwd}}");
    let mut args: Vec<String> = rest.iter().map(|a| a.replace("{{cwd}}", cwd)).collect();
    if !had_token {
        args.push(cwd.to_string());
    }
    Ok(Launch {
        program: prog.replace("{{cwd}}", cwd),
        args,
    })
}

pub fn launch_command(
    p: Platform,
    choice: &str,
    custom: &str,
    cwd: &str,
) -> Result<Launch, String> {
    match (p, choice) {
        (_, "custom") => custom_launch(custom, cwd),
        (Platform::MacOs, "iterm2") => Ok(launch("open", &["-a", "iTerm", cwd])),
        (Platform::MacOs, _) => Ok(launch("open", &["-a", "Terminal", cwd])), // 기본 terminal
        (Platform::Windows, "cmd") => Ok(launch("cmd", &["/c", "start", "", "/D", cwd, "cmd"])),
        (Platform::Windows, _) => Ok(launch("wt", &["-d", cwd])), // 기본 Windows Terminal
        (Platform::Linux, _) => linux_auto_candidates(cwd)
            .into_iter()
            .next()
            .ok_or_else(|| "리눅스 터미널을 찾지 못했습니다".to_string()),
    }
}

/// 리눅스 auto: 우선순위 후보 목록(호출 측이 which로 존재하는 첫 항목을 spawn).
pub fn linux_auto_candidates(cwd: &str) -> Vec<Launch> {
    vec![
        launch("x-terminal-emulator", &["--working-directory", cwd]),
        launch("gnome-terminal", &["--working-directory", cwd]),
        launch("konsole", &["--workdir", cwd]),
        // xterm은 작업 디렉터리 플래그가 없어 셸을 감싼다(그냥 `cd`는 즉시 종료됨).
        launch(
            "xterm",
            &[
                "-e",
                "sh",
                "-c",
                &format!(
                    "cd '{}' && exec \"${{SHELL:-sh}}\"",
                    cwd.replace('\'', "'\\''")
                ),
            ],
        ),
    ]
}

/// AppleScript 문자열 리터럴 이스케이프(역슬래시 → \\, 큰따옴표 → \").
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 원격(ssh) 접속을 각 OS 터미널에서 실행하는 Launch.
/// `ssh_argv`는 remote_shell::ssh_shell_argv, `ssh_cmd`는 shell_join 결과.
pub fn remote_launch_command(
    p: Platform,
    choice: &str,
    ssh_argv: &[String],
    ssh_cmd: &str,
) -> Result<Launch, String> {
    match (p, choice) {
        // 커스텀 템플릿은 {{cwd}} 치환 전제라 원격 명령을 표현할 수 없다 — 명시적 거부.
        (_, "custom") => Err("커스텀 터미널 명령은 아직 원격 접속을 지원하지 않습니다".into()),
        (Platform::MacOs, "iterm2") => Ok(Launch {
            program: "osascript".into(),
            args: vec![
                "-e".into(),
                format!(
                    "tell application \"iTerm\"\nactivate\ncreate window with default profile command \"{}\"\nend tell",
                    applescript_escape(ssh_cmd)
                ),
            ],
        }),
        // macOS Terminal은 `open -a`로 명령 실행이 불가 — do script로 넘긴다.
        (Platform::MacOs, _) => Ok(Launch {
            program: "osascript".into(),
            args: vec![
                "-e".into(),
                format!(
                    "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
                    applescript_escape(ssh_cmd)
                ),
            ],
        }),
        (Platform::Windows, "cmd") => {
            let mut args = vec!["/c".to_string(), "start".into(), String::new()];
            args.extend(ssh_argv.iter().cloned());
            Ok(Launch { program: "cmd".into(), args })
        }
        (Platform::Windows, _) => Ok(Launch { program: "wt".into(), args: ssh_argv.to_vec() }),
        (Platform::Linux, _) => remote_linux_candidates(ssh_argv, ssh_cmd)
            .into_iter()
            .next()
            .ok_or_else(|| "리눅스 터미널을 찾지 못했습니다".to_string()),
    }
}

/// 리눅스 auto: 원격 ssh를 실행하는 우선순위 후보(호출 측이 which로 첫 항목 spawn).
pub fn remote_linux_candidates(ssh_argv: &[String], ssh_cmd: &str) -> Vec<Launch> {
    let mut gnome = vec!["--".to_string()];
    gnome.extend(ssh_argv.iter().cloned());
    let mut konsole = vec!["-e".to_string()];
    konsole.extend(ssh_argv.iter().cloned());
    vec![
        // Debian 대안 시스템: -e 는 단일 문자열 관행.
        Launch {
            program: "x-terminal-emulator".into(),
            args: vec!["-e".into(), ssh_cmd.to_string()],
        },
        Launch {
            program: "gnome-terminal".into(),
            args: gnome,
        },
        Launch {
            program: "konsole".into(),
            args: konsole,
        },
        Launch {
            program: "xterm".into(),
            args: vec!["-e".into(), "sh".into(), "-c".into(), ssh_cmd.to_string()],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_default_uses_open_terminal() {
        let l = launch_command(Platform::MacOs, "terminal", "", "/ws").unwrap();
        assert_eq!(l, launch("open", &["-a", "Terminal", "/ws"]));
    }

    #[test]
    fn macos_iterm2() {
        let l = launch_command(Platform::MacOs, "iterm2", "", "/ws").unwrap();
        assert_eq!(l.args, vec!["-a", "iTerm", "/ws"]);
    }

    #[test]
    fn windows_default_wt_with_cwd() {
        let l = launch_command(Platform::Windows, "wt", "", "C:\\ws").unwrap();
        assert_eq!(l, launch("wt", &["-d", "C:\\ws"]));
    }

    #[test]
    fn custom_substitutes_cwd_token() {
        let l = launch_command(
            Platform::Linux,
            "custom",
            "alacritty --working-directory {{cwd}}",
            "/ws",
        )
        .unwrap();
        assert_eq!(l.program, "alacritty");
        assert_eq!(l.args, vec!["--working-directory", "/ws"]);
    }

    #[test]
    fn custom_without_token_appends_cwd() {
        let l = launch_command(Platform::Linux, "custom", "myterm", "/ws").unwrap();
        assert_eq!(l.program, "myterm");
        assert_eq!(l.args, vec!["/ws"]);
    }

    #[test]
    fn custom_empty_errors() {
        assert!(launch_command(Platform::Linux, "custom", "   ", "/ws").is_err());
    }

    #[test]
    fn linux_auto_has_candidates() {
        let c = linux_auto_candidates("/ws");
        assert!(c.iter().any(|l| l.program == "gnome-terminal"));
    }

    fn ssh_argv() -> Vec<String> {
        vec![
            "ssh".into(),
            "-t".into(),
            "-p".into(),
            "22".into(),
            "me@h".into(),
            "cd '/ws' && exec \"$SHELL\" -l".into(),
        ]
    }

    #[test]
    fn remote_macos_terminal_uses_osascript_do_script() {
        let cmd = r#"ssh -t -p 22 me@h 'cd '\''/ws'\'' && exec "$SHELL" -l'"#;
        let l = remote_launch_command(Platform::MacOs, "terminal", &ssh_argv(), cmd).unwrap();
        assert_eq!(l.program, "osascript");
        assert_eq!(l.args[0], "-e");
        // AppleScript 문자열 안에서 셸 명령의 큰따옴표가 이스케이프돼야 한다.
        assert!(l.args[1].contains(r#"do script "ssh -t -p 22 me@h"#));
        assert!(l.args[1].contains(r#"\"$SHELL\""#));
    }

    #[test]
    fn remote_macos_iterm_creates_window_with_command() {
        let cmd = r#"ssh -t -p 22 me@h 'cd '\''/ws'\'' && exec "$SHELL" -l'"#;
        let l = remote_launch_command(Platform::MacOs, "iterm2", &ssh_argv(), cmd).unwrap();
        assert_eq!(l.program, "osascript");
        assert!(l.args[1].contains("create window with default profile command"));
        // AppleScript 문자열 안에서 셸 명령의 큰따옴표가 이스케이프돼야 한다(Terminal 테스트와 동일 계약).
        assert!(
            l.args[1].contains(r#"create window with default profile command "ssh -t -p 22 me@h"#)
        );
        assert!(l.args[1].contains(r#"\"$SHELL\""#));
    }

    #[test]
    fn remote_windows_wt_passes_argv() {
        let l = remote_launch_command(Platform::Windows, "wt", &ssh_argv(), "unused").unwrap();
        assert_eq!(l.program, "wt");
        assert_eq!(l.args, ssh_argv());
    }

    #[test]
    fn remote_windows_cmd_start() {
        let l = remote_launch_command(Platform::Windows, "cmd", &ssh_argv(), "unused").unwrap();
        assert_eq!(l.program, "cmd");
        assert_eq!(&l.args[..3], &["/c".to_string(), "start".into(), "".into()]);
        assert_eq!(&l.args[3..], ssh_argv().as_slice());
    }

    #[test]
    fn remote_custom_choice_is_rejected() {
        assert!(remote_launch_command(Platform::Linux, "custom", &ssh_argv(), "x").is_err());
    }

    #[test]
    fn remote_linux_candidates_wrap_ssh() {
        let c = remote_linux_candidates(&ssh_argv(), "ssh me@h");
        assert!(c
            .iter()
            .any(|l| l.program == "gnome-terminal" && l.args[0] == "--" && l.args[1] == "ssh"));
        assert!(c
            .iter()
            .any(|l| l.program == "konsole" && l.args[0] == "-e"));
    }
}
