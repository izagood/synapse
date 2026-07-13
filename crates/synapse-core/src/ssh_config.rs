//! `~/.ssh/config` 의 최소 파싱 (GUI 비의존, 순수 함수).
//!
//! 사용자가 `ssh myserver` 처럼 별칭으로 접속할 때, config에서
//! `HostName`/`User`/`Port`/`IdentityFile` 을 해소한다. 파일 IO를 피하려고
//! **config 텍스트를 인자로** 받는다(파일 읽기는 Tauri 셸에서).
//!
//! 지원 범위(YAGNI): `Host` 블록 + `*`/`?` 와일드카드, 위 4개 키워드만.
//! `Match`/`Include`/`ProxyJump`/부정 패턴(`!`)/다중 IdentityFile 누적은 범위 밖.

/// 별칭 해소 결과. config에서 찾은 값만 채워진다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostConfig {
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// `config_text` 에서 `alias` 에 매칭되는 설정을 모은다.
/// ssh 규칙대로 **먼저 나온 값이 우선**(같은 키는 첫 매칭만 채택).
pub fn resolve_host(alias: &str, config_text: &str) -> HostConfig {
    let mut cfg = HostConfig::default();
    let mut active = false; // 현재 Host 블록이 alias 에 매칭되는가

    for raw in config_text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        let Some((keyword, value)) = split_keyword(line) else {
            continue;
        };
        let key = keyword.to_ascii_lowercase();

        if key == "host" {
            active = value
                .split_whitespace()
                .any(|pat| pattern_matches(pat, alias));
            continue;
        }
        if !active {
            continue;
        }
        match key.as_str() {
            "hostname" => set_if_none(&mut cfg.host_name, value.to_string()),
            "user" => set_if_none(&mut cfg.user, value.to_string()),
            "identityfile" => set_if_none(&mut cfg.identity_file, value.to_string()),
            // 첫 매칭만 채택. 잘못된/0 포트 줄은 무시(None 유지)하고
            // 뒤따르는 유효한 Port 줄이 채울 수 있게 둔다.
            "port" if cfg.port.is_none() => {
                cfg.port = value.trim().parse::<u16>().ok().filter(|p| *p != 0);
            }
            _ => {}
        }
    }
    cfg
}

fn set_if_none(slot: &mut Option<String>, value: String) {
    if slot.is_none() {
        *slot = Some(value);
    }
}

/// `#` 이후 주석 제거(인용 처리는 하지 않음 — config에선 흔치 않다).
fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(idx) => &line[..idx],
        None => line,
    }
}

/// `Keyword value` 또는 `Keyword = value` 를 (keyword, value)로 나눈다.
fn split_keyword(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (kw, rest) = (&line[..idx], &line[idx..]);
    // 구분자(공백/'=')를 건너뛴다.
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    if kw.is_empty() || rest.is_empty() {
        return None;
    }
    Some((kw, rest))
}

/// `*`/`?` 와일드카드 패턴 매칭(부정 `!` 패턴은 비매칭으로 처리).
fn pattern_matches(pattern: &str, text: &str) -> bool {
    if pattern.starts_with('!') {
        return false; // 부정 패턴 미지원 — 안전하게 비매칭
    }
    glob_match(pattern.as_bytes(), text.as_bytes())
}

/// 작은 glob 매처: `*`(0개 이상), `?`(정확히 1개). 백트래킹 방식.
fn glob_match(pat: &[u8], txt: &[u8]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star_p, mut star_t): (Option<usize>, usize) = (None, 0);

    while t < txt.len() {
        if p < pat.len() && (pat[p] == txt[t] || pat[p] == b'?') {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == b'*' {
            star_p = Some(p);
            star_t = t;
            p += 1;
        } else if let Some(sp) = star_p {
            p = sp + 1;
            star_t += 1;
            t = star_t;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "\
Host myserver
    HostName 10.0.0.5
    User jaebin
    Port 2222
    IdentityFile ~/.ssh/id_work

Host *.example.com
    User deploy

Host *
    Port 22
";

    #[test]
    fn exact_alias() {
        let c = resolve_host("myserver", CONFIG);
        assert_eq!(c.host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(c.user.as_deref(), Some("jaebin"));
        assert_eq!(c.port, Some(2222));
        assert_eq!(c.identity_file.as_deref(), Some("~/.ssh/id_work"));
    }

    #[test]
    fn wildcard_alias() {
        let c = resolve_host("api.example.com", CONFIG);
        assert_eq!(c.user.as_deref(), Some("deploy"));
        // `Host *` 가 뒤에 있지만 첫 매칭(Port 없음)이라 *의 Port 22 가 채워진다.
        assert_eq!(c.port, Some(22));
        assert_eq!(c.host_name, None); // *.example.com 블록엔 HostName 없음
    }

    #[test]
    fn first_value_wins() {
        let cfg = "\
Host h
    User first
Host h
    User second
";
        assert_eq!(resolve_host("h", cfg).user.as_deref(), Some("first"));
    }

    #[test]
    fn no_match_is_empty() {
        let c = resolve_host("unknownhost", "Host other\n  User x\n");
        assert_eq!(c, HostConfig::default());
    }

    #[test]
    fn equals_syntax_and_comments() {
        let cfg = "\
# 주석
Host h
    HostName = 192.168.0.1  # 인라인 주석
    Port=2022
";
        let c = resolve_host("h", cfg);
        assert_eq!(c.host_name.as_deref(), Some("192.168.0.1"));
        assert_eq!(c.port, Some(2022));
    }

    #[test]
    fn question_mark_wildcard() {
        let cfg = "Host db?\n  User dba\n";
        assert_eq!(resolve_host("db1", cfg).user.as_deref(), Some("dba"));
        assert_eq!(resolve_host("db12", cfg).user, None);
    }

    #[test]
    fn multiple_patterns_on_host_line() {
        let cfg = "Host alpha beta\n  User shared\n";
        assert_eq!(resolve_host("beta", cfg).user.as_deref(), Some("shared"));
        assert_eq!(resolve_host("alpha", cfg).user.as_deref(), Some("shared"));
    }
}
