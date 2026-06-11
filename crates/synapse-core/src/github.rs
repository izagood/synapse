//! GitHub OAuth Device Flow + REST API (FR-4.1, FR-4.2).
//!
//! HTTP는 트레이트로 추상화해 네트워크 없이 테스트한다.
//! 토큰 저장은 이 모듈 책임이 아니다 — 호출자(Tauri 셸)가 OS 키체인에 보관한다.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub trait Http {
    /// form 인코딩 POST, `Accept: application/json` (+ 선택적 bearer 토큰)
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<String, String>;
    fn get_json(&self, url: &str, token: &str) -> Result<String, String>;
    fn post_json(&self, url: &str, token: &str, body: &Value) -> Result<String, String>;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Pending,
    SlowDown,
    Token(String),
    Failed(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepo {
    pub full_name: String,
    pub clone_url: String,
}

/// OS 키체인의 **한 항목**에 직렬화해 보관하는 GitHub 자격 증명.
/// macOS는 키체인 항목마다 접근 허용을 따로 묻기 때문에,
/// 토큰과 로그인명을 항목 두 개에 나눠 담으면 허용 다이얼로그도 두 번 뜬다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credentials {
    pub token: String,
    /// 구버전 항목에서 마이그레이션할 때 로그인명이 없을 수 있다.
    #[serde(default)]
    pub login: String,
}

impl Credentials {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("Credentials는 항상 직렬화 가능")
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| format!("키체인 자격 증명 파싱 실패: {e}"))
    }
}

fn parse(body: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|e| format!("GitHub 응답 파싱 실패: {e}"))
}

fn str_field(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("GitHub 응답에 {key} 없음: {v}"))
}

pub fn start_device_flow(http: &dyn Http, client_id: &str) -> Result<DeviceCode, String> {
    let body = http.post_form(
        "https://github.com/login/device/code",
        &[("client_id", client_id), ("scope", "repo")],
    )?;
    let v = parse(&body)?;
    Ok(DeviceCode {
        device_code: str_field(&v, "device_code")?,
        user_code: str_field(&v, "user_code")?,
        verification_uri: str_field(&v, "verification_uri")?,
        interval: v.get("interval").and_then(Value::as_u64).unwrap_or(5),
    })
}

pub fn poll_device_flow(
    http: &dyn Http,
    client_id: &str,
    device_code: &str,
) -> Result<PollOutcome, String> {
    let body = http.post_form(
        "https://github.com/login/oauth/access_token",
        &[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;
    let v = parse(&body)?;
    if let Some(token) = v.get("access_token").and_then(Value::as_str) {
        return Ok(PollOutcome::Token(token.to_string()));
    }
    match v.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Ok(PollOutcome::Pending),
        Some("slow_down") => Ok(PollOutcome::SlowDown),
        Some(err) => Ok(PollOutcome::Failed(
            v.get("error_description")
                .and_then(Value::as_str)
                .unwrap_or(err)
                .to_string(),
        )),
        None => Err(format!("알 수 없는 GitHub 응답: {v}")),
    }
}

pub fn get_login(http: &dyn Http, token: &str) -> Result<String, String> {
    let body = http.get_json("https://api.github.com/user", token)?;
    str_field(&parse(&body)?, "login")
}

pub fn create_repo(
    http: &dyn Http,
    token: &str,
    name: &str,
    private: bool,
) -> Result<CreatedRepo, String> {
    let body = http.post_json(
        "https://api.github.com/user/repos",
        token,
        &serde_json::json!({ "name": name, "private": private, "auto_init": false }),
    )?;
    let v = parse(&body)?;
    Ok(CreatedRepo {
        full_name: str_field(&v, "full_name")?,
        clone_url: str_field(&v, "clone_url")?,
    })
}

// ---------- ureq 기반 실 구현 ----------

pub struct UreqHttp;

const USER_AGENT: &str = "synapse-app";

/// 네트워크가 응답하지 않아도 요청이 영원히 매달리지 않도록 모든 GitHub
/// 호출에 타임아웃을 둔다 (UI의 syncing 상태가 영구히 잠기는 것을 방지).
fn agent() -> &'static ureq::Agent {
    use std::sync::OnceLock;
    use std::time::Duration;
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
    })
}

impl Http for UreqHttp {
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<String, String> {
        let req = agent()
            .post(url)
            .set("Accept", "application/json")
            .set("User-Agent", USER_AGENT);
        match req.send_form(form) {
            Ok(res) => res.into_string().map_err(|e| e.to_string()),
            // 4xx에도 본문에 의미 있는 error 필드가 온다 (device flow pending 등)
            Err(ureq::Error::Status(_, res)) => res.into_string().map_err(|e| e.to_string()),
            Err(e) => Err(format!("GitHub 요청 실패: {e}")),
        }
    }

    fn get_json(&self, url: &str, token: &str) -> Result<String, String> {
        agent()
            .get(url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", USER_AGENT)
            .call()
            .map_err(|e| format!("GitHub 요청 실패: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())
    }

    fn post_json(&self, url: &str, token: &str, body: &Value) -> Result<String, String> {
        let req = agent()
            .post(url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", USER_AGENT);
        match req.send_json(body.clone()) {
            Ok(res) => res.into_string().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, res)) => {
                let text = res.into_string().unwrap_or_default();
                Err(format!("GitHub API 오류 ({code}): {text}"))
            }
            Err(e) => Err(format!("GitHub 요청 실패: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeHttp {
        responses: RefCell<Vec<String>>,
        requests: RefCell<Vec<String>>,
    }

    impl FakeHttp {
        fn new(responses: &[&str]) -> Self {
            FakeHttp {
                responses: RefCell::new(responses.iter().rev().map(|s| s.to_string()).collect()),
                requests: RefCell::new(vec![]),
            }
        }
        fn next(&self) -> Result<String, String> {
            self.responses.borrow_mut().pop().ok_or("no more responses".to_string())
        }
    }

    impl Http for FakeHttp {
        fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<String, String> {
            self.requests.borrow_mut().push(format!("POST {url} {form:?}"));
            self.next()
        }
        fn get_json(&self, url: &str, _token: &str) -> Result<String, String> {
            self.requests.borrow_mut().push(format!("GET {url}"));
            self.next()
        }
        fn post_json(&self, url: &str, _token: &str, body: &Value) -> Result<String, String> {
            self.requests.borrow_mut().push(format!("POST {url} {body}"));
            self.next()
        }
    }

    #[test]
    fn device_flow_start_parses_codes() {
        let http = FakeHttp::new(&[
            r#"{"device_code":"dc1","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":5}"#,
        ]);
        let dc = start_device_flow(&http, "client123").unwrap();
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.interval, 5);
        assert!(http.requests.borrow()[0].contains("client123"));
        assert!(http.requests.borrow()[0].contains("\"repo\""));
    }

    #[test]
    fn device_flow_poll_lifecycle() {
        let http = FakeHttp::new(&[
            r#"{"error":"authorization_pending"}"#,
            r#"{"error":"slow_down","interval":10}"#,
            r#"{"access_token":"gho_token","token_type":"bearer","scope":"repo"}"#,
        ]);
        assert_eq!(poll_device_flow(&http, "c", "dc").unwrap(), PollOutcome::Pending);
        assert_eq!(poll_device_flow(&http, "c", "dc").unwrap(), PollOutcome::SlowDown);
        assert_eq!(
            poll_device_flow(&http, "c", "dc").unwrap(),
            PollOutcome::Token("gho_token".to_string())
        );
    }

    #[test]
    fn device_flow_poll_failure_carries_description() {
        let http = FakeHttp::new(&[
            r#"{"error":"expired_token","error_description":"기기 코드 만료"}"#,
        ]);
        assert_eq!(
            poll_device_flow(&http, "c", "dc").unwrap(),
            PollOutcome::Failed("기기 코드 만료".to_string())
        );
    }

    #[test]
    fn create_repo_returns_clone_url() {
        let http = FakeHttp::new(&[
            r#"{"full_name":"me/notes","clone_url":"https://github.com/me/notes.git","private":true}"#,
        ]);
        let repo = create_repo(&http, "tok", "notes", true).unwrap();
        assert_eq!(repo.full_name, "me/notes");
        assert_eq!(repo.clone_url, "https://github.com/me/notes.git");
        assert!(http.requests.borrow()[0].contains("\"private\":true"));
    }

    #[test]
    fn get_login_extracts_username() {
        let http = FakeHttp::new(&[r#"{"login":"izagood","id":1}"#]);
        assert_eq!(get_login(&http, "tok").unwrap(), "izagood");
    }

    #[test]
    fn credentials_roundtrip_json() {
        let creds = Credentials { token: "ghp_abc".to_string(), login: "izagood".to_string() };
        assert_eq!(Credentials::from_json(&creds.to_json()).unwrap(), creds);
    }

    #[test]
    fn credentials_login_defaults_to_empty_when_missing() {
        let creds = Credentials::from_json(r#"{"token":"ghp_abc"}"#).unwrap();
        assert_eq!(creds.token, "ghp_abc");
        assert_eq!(creds.login, "");
    }

    #[test]
    fn credentials_from_invalid_json_is_error() {
        assert!(Credentials::from_json("ghp_plain_token").is_err());
    }
}
