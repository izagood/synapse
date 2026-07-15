//! SSH 연결·인증·호스트키 검증 (원격 워크스페이스용).
//!
//! 순수 Rust 스택(russh + russh-sftp, crypto=ring)을 쓴다. synapse-core는
//! 동기 코드이므로, async russh 호출은 **core 전용 tokio 런타임**에서
//! `block_on`으로 돌린다(메인/Tauri 런타임과 분리해 중첩 런타임 패닉을 피한다).
//! 이 모듈의 동기 함수들은 Tauri의 `spawn_blocking` 스레드풀에서 호출되므로
//! UI를 막지 않는다.
//!
//! 인증 우선순위: SSH 에이전트 → `~/.ssh` 키 파일 → 비밀번호.
//! 호스트키는 `known_hosts`로 검증한다(불일치는 거부, 미등록은 정책에 따름).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use russh::client::{self, AuthResult, Config, Handle};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{known_hosts, load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use tokio::runtime::Runtime;

use crate::location::SshLocation;

/// core 전용 멀티스레드 tokio 런타임(모든 SSH 세션이 공유).
pub fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("synapse-ssh")
            .build()
            .expect("tokio 런타임 생성 실패")
    })
}

/// 미등록 호스트키를 만났을 때의 정책.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyPolicy {
    /// known_hosts에 일치하는 키가 있어야만 연결(미등록·불일치 모두 거부).
    Strict,
    /// 미등록 호스트키는 학습(known_hosts에 추가)하고 연결(TOFU). 불일치는 거부.
    AcceptNew,
}

/// 연결에 필요한 환경 의존 설정. GUI 비의존을 위해 경로는 호출부(src-tauri)가 채운다.
#[derive(Debug, Clone)]
pub struct SshConfig {
    pub known_hosts: PathBuf,
    /// 시도할 개인키 파일들(존재하지 않으면 건너뜀).
    pub identity_files: Vec<PathBuf>,
    pub use_agent: bool,
    pub host_key_policy: HostKeyPolicy,
    /// 암호화된 키의 passphrase(없으면 평문 키만 로드).
    pub passphrase: Option<String>,
    /// 비밀번호 인증(최후 수단).
    pub password: Option<String>,
}

/// 사용자가 입력한 경로의 선행 틸드(`~`, `~/...`)를 홈 디렉토리로 확장한다.
///
/// GUI 키 경로 필드에는 `~/.ssh/id_xxx`처럼 틸드 경로를 넣는 경우가 많은데,
/// 셸이 아닌 곳에서는 `~`가 풀리지 않아 `Path::exists()`가 false가 되고
/// 해당 키가 조용히 건너뛰어진다(=인증 실패). 여기서 미리 확장해 둔다.
/// 셸과 달리 `~user` 형태는 다루지 않는다(앱 사용자 본인 홈만 대상).
pub fn expand_tilde(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

impl SshConfig {
    /// 홈 디렉토리 기준 표준 경로로 기본 설정을 만든다.
    /// `~/.ssh/known_hosts`, `~/.ssh/{id_ed25519,id_ecdsa,id_rsa}`, 에이전트 사용.
    pub fn with_defaults(home: &Path) -> Self {
        let ssh = home.join(".ssh");
        SshConfig {
            known_hosts: ssh.join("known_hosts"),
            identity_files: ["id_ed25519", "id_ecdsa", "id_rsa"]
                .iter()
                .map(|n| ssh.join(n))
                .collect(),
            use_agent: true,
            host_key_policy: HostKeyPolicy::AcceptNew,
            passphrase: None,
            password: None,
        }
    }
}

/// SSH 연결 오류(프론트에 의미 있는 분류로 전달).
#[derive(Debug)]
pub enum SshError {
    Connect(String),
    /// known_hosts에 없는 호스트(정책이 Strict일 때). fingerprint를 보여 사용자 승인을 받는다.
    UnknownHostKey {
        fingerprint: String,
    },
    /// known_hosts와 다른 키(중간자 공격 의심). 항상 거부.
    HostKeyMismatch {
        fingerprint: String,
    },
    Auth(String),
    Sftp(String),
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::Connect(m) => write!(f, "연결 실패: {m}"),
            SshError::UnknownHostKey { fingerprint } => {
                write!(f, "알 수 없는 호스트키: {fingerprint}")
            }
            SshError::HostKeyMismatch { fingerprint } => {
                write!(f, "호스트키 불일치(보안 경고): {fingerprint}")
            }
            SshError::Auth(m) => write!(f, "인증 실패: {m}"),
            SshError::Sftp(m) => write!(f, "SFTP 오류: {m}"),
        }
    }
}

impl std::error::Error for SshError {}

/// 호스트키 검증 결과(핸들러가 채우고 connect가 읽는다).
#[derive(Debug, Clone, Default)]
enum HostKeyOutcome {
    #[default]
    Pending,
    Accepted,
    Unknown {
        fingerprint: String,
    },
    Mismatch {
        fingerprint: String,
    },
}

/// russh 클라이언트 핸들러: 호스트키만 검증한다.
struct Verifier {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    policy: HostKeyPolicy,
    outcome: Arc<Mutex<HostKeyOutcome>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        match known_hosts::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
            // known_hosts에 일치하는 키가 있음 → 신뢰
            Ok(true) => {
                *self.outcome.lock().unwrap() = HostKeyOutcome::Accepted;
                Ok(true)
            }
            // 미등록 호스트
            Ok(false) => match self.policy {
                HostKeyPolicy::AcceptNew => {
                    let _ = known_hosts::learn_known_hosts_path(
                        &self.host,
                        self.port,
                        key,
                        &self.known_hosts,
                    );
                    *self.outcome.lock().unwrap() = HostKeyOutcome::Accepted;
                    Ok(true)
                }
                HostKeyPolicy::Strict => {
                    *self.outcome.lock().unwrap() = HostKeyOutcome::Unknown { fingerprint };
                    Ok(false)
                }
            },
            // known_hosts에 기록된 키와 다름 → 중간자 의심, 거부
            Err(_) => {
                *self.outcome.lock().unwrap() = HostKeyOutcome::Mismatch { fingerprint };
                Ok(false)
            }
        }
    }
}

/// 인증까지 끝난 SSH 연결 + SFTP 세션. SftpBackend·git runner가 Arc로 공유한다.
pub struct SshSession {
    handle: Handle<Verifier>,
    sftp: SftpSession,
    loc: SshLocation,
}

impl SshSession {
    pub fn sftp(&self) -> &SftpSession {
        &self.sftp
    }

    pub fn location(&self) -> &SshLocation {
        &self.loc
    }

    /// 원격에서 셸 명령을 실행한다(git over SSH용). (성공여부, stdout, stderr) 반환.
    pub fn exec(&self, command: &str) -> Result<(bool, Vec<u8>, Vec<u8>), SshError> {
        runtime().block_on(self.exec_async(command))
    }

    async fn exec_async(&self, command: &str) -> Result<(bool, Vec<u8>, Vec<u8>), SshError> {
        use russh::ChannelMsg;
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        // 원시 메시지 루프로 stdout/stderr/종료코드를 모두 수집한다(git over SSH용).
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code: Option<u32> = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, ext } => {
                    // ext == 1 은 stderr (SSH_EXTENDED_DATA_STDERR)
                    if ext == 1 {
                        stderr.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => {}
                _ => {}
            }
        }
        Ok((code == Some(0), stdout, stderr))
    }
}

/// 원격 위치에 연결하고 인증한 세션을 만든다(동기 진입점).
pub fn connect(loc: &SshLocation, cfg: &SshConfig) -> Result<Arc<SshSession>, SshError> {
    runtime().block_on(connect_async(loc, cfg))
}

async fn connect_async(loc: &SshLocation, cfg: &SshConfig) -> Result<Arc<SshSession>, SshError> {
    let config = Arc::new(Config::default());
    let outcome = Arc::new(Mutex::new(HostKeyOutcome::default()));
    let verifier = Verifier {
        host: loc.host.clone(),
        port: loc.port,
        known_hosts: cfg.known_hosts.clone(),
        policy: cfg.host_key_policy,
        outcome: outcome.clone(),
    };

    let mut handle = match client::connect(config, (loc.host.as_str(), loc.port), verifier).await {
        Ok(h) => h,
        Err(e) => {
            // 호스트키 거부로 인한 실패는 더 구체적인 오류로 바꾼다.
            return Err(match outcome.lock().unwrap().clone() {
                HostKeyOutcome::Unknown { fingerprint } => SshError::UnknownHostKey { fingerprint },
                HostKeyOutcome::Mismatch { fingerprint } => {
                    SshError::HostKeyMismatch { fingerprint }
                }
                _ => SshError::Connect(e.to_string()),
            });
        }
    };

    authenticate(&mut handle, &loc.user, cfg).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    Ok(Arc::new(SshSession {
        handle,
        sftp,
        loc: loc.clone(),
    }))
}

/// 에이전트 → 키파일 → 비밀번호 순으로 인증을 시도한다.
async fn authenticate(
    handle: &mut Handle<Verifier>,
    user: &str,
    cfg: &SshConfig,
) -> Result<(), SshError> {
    // RSA 키는 서버와 협상한 rsa-sha2 해시로 서명해야 한다. 기본값(None)은
    // 레거시 ssh-rsa(SHA-1) 서명이라 OpenSSH 8.8+ 서버가 기본 거부한다(RFC 8332).
    // 서버가 server-sig-algs 확장을 안 주면 rsa-sha2-256을 시도한다 — 확장만
    // 구현 안 한 서버도 rsa-sha2 서명 자체는 사실상 전부 받는다.
    // (비-RSA 키에는 PrivateKeyWithHashAlg가 이 값을 무시하므로 무해하다.)
    let rsa_hash = match handle.best_supported_rsa_hash().await {
        Ok(Some(server_pref)) => server_pref,
        Ok(None) | Err(_) => Some(HashAlg::Sha256),
    };

    // 1. SSH 에이전트 (플랫폼별: unix는 SSH_AUTH_SOCK, Windows는 현재 미지원)
    if cfg.use_agent && try_agent_auth(handle, user, rsa_hash).await {
        return Ok(());
    }

    // 2. ~/.ssh 키 파일 — 로드 실패는 건너뛰되 사유를 모아 최종 오류에 싣는다
    // (조용히 삼키면 "지원 안 되는 키 포맷" 같은 원인이 진단 불가능해진다).
    let mut key_errors: Vec<String> = Vec::new();
    for path in &cfg.identity_files {
        if !path.exists() {
            continue;
        }
        let key = match load_secret_key(path, cfg.passphrase.as_deref()) {
            Ok(k) => k,
            Err(e) => {
                key_errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        let with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash);
        if let Ok(AuthResult::Success) = handle.authenticate_publickey(user, with_alg).await {
            return Ok(());
        }
    }

    // 3. 비밀번호
    if let Some(password) = &cfg.password {
        if let Ok(AuthResult::Success) = handle.authenticate_password(user, password).await {
            return Ok(());
        }
    }

    let mut msg =
        "사용 가능한 인증 수단으로 로그인하지 못했습니다(에이전트/키/비밀번호)".to_string();
    if !key_errors.is_empty() {
        msg.push_str(&format!(" — 로드 실패한 키: {}", key_errors.join(", ")));
    }
    Err(SshError::Auth(msg))
}

/// SSH 에이전트로 공개키 인증을 시도한다. 성공하면 true.
/// 에이전트 소켓 접근 방식이 플랫폼마다 달라 cfg로 분기한다.
/// `rsa_hash`: RSA 키에 쓸 서명 해시(협상 결과). 비-RSA 키에는 넘기지 않는다.
#[cfg(unix)]
async fn try_agent_auth(
    handle: &mut Handle<Verifier>,
    user: &str,
    rsa_hash: Option<HashAlg>,
) -> bool {
    use russh::keys::agent::client::AgentClient;
    use russh::keys::agent::AgentIdentity;

    let Ok(mut agent) = AgentClient::connect_env().await else {
        return false;
    };
    let Ok(identities) = agent.request_identities().await else {
        return false;
    };
    for identity in identities {
        if let AgentIdentity::PublicKey { key, .. } = identity {
            let hash = if key.algorithm().is_rsa() {
                rsa_hash
            } else {
                None
            };
            if let Ok(AuthResult::Success) = handle
                .authenticate_publickey_with(user, key, hash, &mut agent)
                .await
            {
                return true;
            }
        }
    }
    false
}

/// 비-unix(Windows 등): SSH 에이전트(Pageant)는 현재 미지원 — 키 파일/비밀번호로 인증한다.
#[cfg(not(unix))]
async fn try_agent_auth(
    _handle: &mut Handle<Verifier>,
    _user: &str,
    _rsa_hash: Option<HashAlg>,
) -> bool {
    false
}

/// POSIX 셸 작은따옴표 인용. 임의 문자열을 한 인자로 안전하게 감싼다
/// (공백·한글·`$`·따옴표 포함). git over SSH exec에서 인자 주입을 막는다.
pub fn sh_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            // 작은따옴표는 인용을 닫고 escaped 따옴표를 넣은 뒤 다시 연다.
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// 원격 호스트에서 실행할 git 명령 문자열을 안전하게 조립한다.
/// `cd <cwd> && env K=V … git <args…>` 형태이며 모든 동적 값은 셸 인용된다.
pub fn remote_git_command(cwd: &str, envs: &[(&str, &str)], args: &[&str]) -> String {
    let mut cmd = format!("cd {} && ", sh_single_quote(cwd));
    if !envs.is_empty() {
        cmd.push_str("env");
        for (k, v) in envs {
            cmd.push(' ');
            cmd.push_str(k);
            cmd.push('=');
            cmd.push_str(&sh_single_quote(v));
        }
        cmd.push(' ');
    }
    cmd.push_str("git");
    for a in args {
        cmd.push(' ');
        cmd.push_str(&sh_single_quote(a));
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 레거시 PEM(PKCS#1) RSA 개인키 — `ssh-keygen -t rsa -m PEM`의 출력 포맷으로,
    /// 실사용 `~/.ssh/id_rsa`에 여전히 흔하다. russh를 default-features=false로
    /// 빌드하면서 `rsa` feature가 빠지면 "Unsupported key type RSA"로 로드가
    /// 실패하고, authenticate()가 키를 조용히 건너뛰어 원격 연결 전체가 인증
    /// 실패로 죽는다. 이 테스트가 그 회귀를 잡는다.
    /// (테스트 전용으로 생성한 일회용 키다 — 어떤 시스템에도 등록돼 있지 않다.)
    const PKCS1_RSA_TEST_KEY: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAtrpqGKm3IB2MDcSJpKoBfstlnzXrD2Vf66Dqr6WGtkioQNfo
Z8PB/5Z9BsLof3E0fpu9qpNhjIYYqbC4OwfrjvX7fKwGHmT30tQgbHYr/K3o3JpQ
AHFg04fv04euxURE3W+/EKlv/QTJIO2fsve8TraJblVsql9J3m7thrSAkDrAzz6u
2Y5jCFsdq4pAb+wxES/uDTjfFd8JY8Tf8JQ1cmh/XYq3a1JtMV7rGsKmRKqufRZt
qKsGVEpUNo5CHyAfUmC7c4XAwORUmetZuYGliYtFHRNjRYYT5t2MjS5QX3dQp6wC
lnAv83vRC2AcYUQ6E11VT3xXomvFe3o8ggL9JQIDAQABAoIBAE2SieP6eKGLqZ9W
plBfU88uLfAPBcE9eiEf6UGz9aKA6dzNS/5xHnSQwHcUW3tu5agyGazGcI0liGbR
fQSich/40VC1/sr8djDsmO8yo63bbpXodLobZ82lUeztFwbr2ohfHi/GnqI9W908
w6VIgoqv91v9q+oQFd32HaQoEMQpVUcf8m4OzjVueJ+VrTZQaIeeDb6XdafpvBnV
R212xnWz7n7Ss39Rn214NTaBGpu9yeJBzID/R5JOPuHZgQNIkFDNb2RSDZkK2mgh
0GgCXtfnDcv6RUOQWzBjVgqqa6Qq+A9Utlj9Ao4QA9FsjmqRAr8SF5UvcNQbhI1D
4KCmZmkCgYEA4pRC97XlE8Q8J1HwNWu6WjVKJbrb5RaUBUHMM1LT2tdg1cYKx1ko
DrUF2LQ9v5km2VnwAfKR3wQTW/QB0jJy88HRDr/cOUaI8dshbjs9ZC7UvzAH2BU2
ycILmt8P8Hk6f8LyEdtxxPPEWh8NSEBuLRR0Q4GHy6l/qdkh8gWuNGMCgYEAznR/
tCO99Hu+/eBOh4d287uKTvydKbPr0Z8KtzpNIqN5Ibe688nCS4CjnW0kJdaz1IxJ
ovLr0o3m+w5pAQp+IvVDW1iAFkqPnh8pY168UziKRHVC4zqQQzxoU7YZ5mGC+8An
LoeLt9a1zzTAzf1l1mAyozX+plRFJw4WuR4satcCgYA0Zt+6FHpfgPH8kgnBASI/
PLXiVf4HVJp1QMtuT0iqA0flCQFzK16FUD6C6OSjDFOczx0gBi7Qakvj52IIcBx/
3aJxC9Rt9q8zaF+p8891/RK9COm3guiB7vvqHI6+KftqkvaTRLJiP5J42VekDyqs
CF//QNTcOF5LNOmR5NhuSwKBgQCfojDEJwbPrYdGYlQWM0Zku1P8MxOKlVX35ZOx
jWDrMZ+N1LS3n/+dxb+9EBDtORAffsHJPy/cxGAfK0tBxM03VpFYZhvUIJ7f0pR8
A1p2trciq9CmRjgZ5PF+GMX5/tf6tN8W+TOtWFWH+/BA1ngRxJwi2rMmBO7bfedQ
B+asTQKBgQDCOGf297mVWvEoxmKVwm4MXGHtG2D04mZTAREwsY5WaYHKSAVt6Dhx
yWJZLMDm2Z9hNu7MnLDv6ZWR9Eb67blQfkpic5irRWC5ZDbd58pc0oZQvHzrUfTO
aSQAtymkMzABl2XVe7MLgxIN+evb3FJl/MveCGkbHg6Fkz04SKi4Cg==
-----END RSA PRIVATE KEY-----
";

    #[test]
    fn pkcs1_rsa_pem_key_loads() {
        let key = russh::keys::decode_secret_key(PKCS1_RSA_TEST_KEY, None)
            .expect("PKCS#1 PEM RSA 키가 로드돼야 한다(russh `rsa` feature 필요)");
        assert!(key.algorithm().is_rsa());
    }

    #[test]
    fn load_secret_key_reads_pkcs1_rsa_from_file() {
        // authenticate()가 실제로 쓰는 파일 경로 로드도 같은 포맷을 지원해야 한다.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_rsa");
        std::fs::write(&path, PKCS1_RSA_TEST_KEY).unwrap();
        let key = load_secret_key(&path, None)
            .expect("파일 기반 load_secret_key도 PKCS#1 RSA를 읽어야 한다");
        assert!(key.algorithm().is_rsa());
    }

    #[test]
    fn sh_single_quote_escapes_special_chars() {
        assert_eq!(sh_single_quote("a b"), "'a b'");
        assert_eq!(sh_single_quote("note.md"), "'note.md'");
        // 작은따옴표: 닫고-escaped-열기
        assert_eq!(sh_single_quote("it's"), "'it'\\''s'");
        // $ · 백틱 · 한글은 작은따옴표 안에서 리터럴로 보존된다
        assert_eq!(sh_single_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(sh_single_quote("메 모"), "'메 모'");
    }

    #[test]
    fn remote_git_command_quotes_cwd_env_and_args() {
        let cmd = remote_git_command(
            "/srv/내 노트",
            &[("GIT_TERMINAL_PROMPT", "0")],
            &["commit", "-m", "메 시지 $x"],
        );
        assert_eq!(
            cmd,
            "cd '/srv/내 노트' && env GIT_TERMINAL_PROMPT='0' git 'commit' '-m' '메 시지 $x'"
        );
    }

    #[test]
    fn remote_git_command_without_env() {
        assert_eq!(
            remote_git_command("/srv/notes", &[], &["status", "--porcelain"]),
            "cd '/srv/notes' && git 'status' '--porcelain'"
        );
    }

    #[test]
    fn default_config_uses_standard_ssh_paths() {
        let cfg = SshConfig::with_defaults(Path::new("/home/me"));
        assert_eq!(cfg.known_hosts, PathBuf::from("/home/me/.ssh/known_hosts"));
        assert!(cfg
            .identity_files
            .contains(&PathBuf::from("/home/me/.ssh/id_ed25519")));
        assert!(cfg.use_agent);
        assert_eq!(cfg.host_key_policy, HostKeyPolicy::AcceptNew);
    }

    #[test]
    fn expand_tilde_resolves_user_home() {
        let home = Path::new("/home/me");
        // 흔한 케이스: GUI에 `~/.ssh/...`를 입력 → 홈으로 확장돼 실제 키를 찾는다.
        assert_eq!(
            expand_tilde("~/.ssh/work_key", home),
            PathBuf::from("/home/me/.ssh/work_key")
        );
        // 틸드 단독.
        assert_eq!(expand_tilde("~", home), PathBuf::from("/home/me"));
        // 절대 경로·상대 경로는 그대로 둔다.
        assert_eq!(
            expand_tilde("/etc/ssh/key", home),
            PathBuf::from("/etc/ssh/key")
        );
        assert_eq!(expand_tilde("keys/id", home), PathBuf::from("keys/id"));
        // 경로 중간의 틸드는 확장하지 않는다(선행 `~/`만 대상).
        assert_eq!(expand_tilde("/a/~/b", home), PathBuf::from("/a/~/b"));
    }

    #[test]
    fn runtime_is_reusable_singleton() {
        // 같은 런타임 인스턴스를 돌려준다(주소 동일).
        let a = runtime() as *const Runtime;
        let b = runtime() as *const Runtime;
        assert_eq!(a, b);
        // 런타임에서 간단한 future가 동작한다.
        let v = runtime().block_on(async { 1 + 1 });
        assert_eq!(v, 2);
    }
}
