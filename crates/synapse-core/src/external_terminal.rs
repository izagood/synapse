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
    Launch { program: program.to_string(), args: args.iter().map(|s| s.to_string()).collect() }
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
    Ok(Launch { program: prog.replace("{{cwd}}", cwd), args })
}

pub fn launch_command(p: Platform, choice: &str, custom: &str, cwd: &str) -> Result<Launch, String> {
    match (p, choice) {
        (_, "custom") => custom_launch(custom, cwd),
        (Platform::MacOs, "iterm2") => Ok(launch("open", &["-a", "iTerm", cwd])),
        (Platform::MacOs, _) => Ok(launch("open", &["-a", "Terminal", cwd])), // 기본 terminal
        (Platform::Windows, "cmd") => {
            Ok(launch("cmd", &["/c", "start", "", "/D", cwd, "cmd"]))
        }
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
        launch("xterm", &["-e", "sh", "-c", &format!("cd '{}' && exec \"${{SHELL:-sh}}\"", cwd.replace('\'', "'\\''"))]),
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
        let l = launch_command(Platform::Linux, "custom", "alacritty --working-directory {{cwd}}", "/ws").unwrap();
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
}
