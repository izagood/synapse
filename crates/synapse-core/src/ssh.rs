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
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
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
    // 1. SSH 에이전트
    if cfg.use_agent {
        if let Ok(mut agent) = AgentClient::connect_env().await {
            if let Ok(identities) = agent.request_identities().await {
                for identity in identities {
                    if let AgentIdentity::PublicKey { key, .. } = identity {
                        if let Ok(result) = handle
                            .authenticate_publickey_with(user, key, None, &mut agent)
                            .await
                        {
                            if result.success() {
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. ~/.ssh 키 파일
    for path in &cfg.identity_files {
        if !path.exists() {
            continue;
        }
        let key = match load_secret_key(path, cfg.passphrase.as_deref()) {
            Ok(k) => k,
            Err(_) => continue, // 암호화된 키 등은 건너뛴다
        };
        let with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
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

    Err(SshError::Auth(
        "사용 가능한 인증 수단으로 로그인하지 못했습니다(에이전트/키/비밀번호)".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
