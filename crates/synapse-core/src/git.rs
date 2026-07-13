//! GitHub 동기화 엔진 (FR-4).
//!
//! 시스템 `git` CLI를 서브프로세스로 구동한다. libgit2 대비 선택 이유:
//! 충돌·rebase 동작이 사용자의 git과 100% 동일하고, 실제 리포지토리로
//! 통합 테스트가 가능하다. git 미설치 환경은 `SyncState::NoGit`으로 안내한다.
//!
//! 상태 머신: idle → dirty → committing → fetching/merging/pushing → synced | conflict
//! 디스크가 유일한 진실이다: 병합 전 무조건 커밋해 로컬 편집을 보존하고,
//! 업스트림과 갈라졌으면 merge 커밋으로 수렴시킨다. 텍스트 충돌은 문자 단위
//! 3-way 병합으로 자동 해소하고, 자동 해소가 불가능한 충돌(삭제/수정 등)만
//! merge --abort 후 호출자에게 보고한다 — 해결은 `resolve_conflicts`의 3택으로 수행한다.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::paths::DATA_DIR;
use crate::sftp::SftpBackend;
use crate::ssh::SshSession;
use crate::vfs::{Backend, LocalBackend};

/// git 명령 실행 위치. 로컬은 시스템 `git`, 원격은 SSH exec 채널에서 원격 `git`.
enum GitExec {
    Local,
    Remote(Arc<SshSession>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    NoGit,
    NoRepo,
    NoRemote,
    Synced,
    Pending,
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    pub ahead: u32,
    pub behind: u32,
    pub conflict_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SyncStatus {
    fn simple(state: SyncState) -> Self {
        SyncStatus {
            state,
            ahead: 0,
            behind: 0,
            conflict_files: vec![],
            message: None,
        }
    }
}

/// 파일 히스토리 한 항목 (FR-4.7). git log 한 커밋에 대응한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    /// 전체 커밋 해시 (`git show <hash>:<path>`에 그대로 쓴다)
    pub hash: String,
    /// 짧은 해시 (UI 표시용)
    pub short_hash: String,
    pub author: String,
    /// 커밋 시각 (ISO 8601, 예: 2026-06-11T10:30:00+09:00)
    pub timestamp: String,
    pub message: String,
}

/// 충돌한 파일 하나의 양쪽 내용 (FR-4.5 diff 뷰용).
/// 충돌 상태에서 repo는 깨끗하므로 mine=`HEAD:파일`, theirs=`업스트림:파일`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPreview {
    /// 워크스페이스 루트 기준 상대 경로
    pub path: String,
    /// 내 버전 (로컬 HEAD). 내 쪽에서 삭제된 경우 None
    pub mine: Option<String>,
    /// 원격 버전 (업스트림). 원격에서 삭제된 경우 None
    pub theirs: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// 내 버전 유지 (rebase -Xtheirs: 재생되는 로컬 커밋 우선)
    KeepMine,
    /// 원격 버전 가져오기 (rebase -Xours: 업스트림 우선)
    KeepRemote,
    /// 원격을 받아들이고 내 버전은 "이름 (conflict).ext"로 보존
    KeepBoth,
}

pub struct GitWorkspace {
    root: PathBuf,
    /// "AUTHORIZATION: basic …" 형태의 추가 헤더 (GitHub HTTPS 인증, 로컬 전용)
    auth_header: Option<String>,
    /// git 명령 실행 위치(로컬 프로세스 또는 원격 SSH exec).
    exec: GitExec,
    /// 워킹트리 파일 I/O 백엔드(충돌 해결 시 머지 결과 쓰기 등). 로컬/원격 일치.
    backend: Arc<dyn Backend>,
    /// CRDT·워킹트리를 만지는 로컬 구간에서만 잡는 락. 네트워크 구간
    /// (fetch/push)에서는 풀어 두어 저장(save_doc)이 동기화에 막히지 않는다.
    lock: &'static Mutex<()>,
    /// fetch 직후(락이 풀린 네트워크 구간)에 호출되는 테스트 훅
    #[cfg(test)]
    after_fetch: Option<Box<dyn Fn() + Send + Sync>>,
}

type GitResult<T> = Result<T, String>;

/// 원격 통신 명령이 네트워크 문제로 영원히 매달리지 않도록 하는 타임아웃.
/// 로컬 명령(status, rebase 등)은 리포지토리 크기에 따라 오래 걸릴 수
/// 있으므로 제한하지 않는다.
fn network_timeout_for(args: &[&str]) -> Option<Duration> {
    match args.first().copied() {
        Some("fetch") | Some("push") | Some("ls-remote") => Some(Duration::from_secs(120)),
        Some("clone") => Some(Duration::from_secs(600)),
        _ => None,
    }
}

/// Windows에서 GUI 앱(`windows_subsystem = "windows"`)이 콘솔 자식 프로세스
/// (`git` 등)를 spawn할 때마다 콘솔 창이 깜빡이는 것을 막는다.
/// `CREATE_NO_WINDOW`(0x0800_0000). 다른 OS에선 콘솔 창 개념이 없어 무동작.
#[cfg(windows)]
fn suppress_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn suppress_console_window(_cmd: &mut Command) {}

/// 타임아웃이 있으면 프로세스를 폴링하다가 초과 시 kill 한다.
/// stdout/stderr는 별도 스레드로 빨아들여 파이프 버퍼 교착을 막는다.
fn run_command(
    mut cmd: Command,
    timeout: Option<Duration>,
) -> Result<(bool, Vec<u8>, String), String> {
    suppress_console_window(&mut cmd);
    let Some(timeout) = timeout else {
        let out = cmd
            .output()
            .map_err(|e| format!("git 실행 실패 (git이 설치되어 있나요?): {e}"))?;
        return Ok((
            out.status.success(),
            out.stdout,
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ));
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git 실행 실패 (git이 설치되어 있나요?): {e}"))?;
    let mut out_pipe = child.stdout.take().expect("piped stdout");
    let mut err_pipe = child.stderr.take().expect("piped stderr");
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "명령이 {}초 안에 끝나지 않아 중단했습니다 (네트워크 상태를 확인하세요)",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok((
        status.success(),
        stdout,
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

/// 같은 프로세스 안에서 여러 `GitWorkspace`(멀티 윈도우)가 한 워크스페이스의
/// git/워킹트리를 동시에 만지지 않도록 직렬화한다.
fn workspace_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

impl GitWorkspace {
    pub fn new(root: impl Into<PathBuf>, auth_header: Option<String>) -> Self {
        GitWorkspace {
            root: root.into(),
            auth_header,
            exec: GitExec::Local,
            backend: Arc::new(LocalBackend),
            lock: workspace_lock(),
            #[cfg(test)]
            after_fetch: None,
        }
    }

    /// 원격 SSH 호스트의 워크스페이스에 대한 git 작업. git 명령은 원격 호스트의
    /// `git`을 SSH exec로 실행하고(원격 자격증명 사용), 워킹트리 파일은 SFTP로
    /// 만진다. 로컬 git이 SFTP 트리를 직접 다룰 수 없으므로 필수 구조다.
    pub fn new_remote(session: Arc<SshSession>, root: impl Into<PathBuf>) -> Self {
        let backend: Arc<dyn Backend> = Arc::new(SftpBackend::new(session.clone()));
        GitWorkspace {
            root: root.into(),
            auth_header: None,
            exec: GitExec::Remote(session),
            backend,
            lock: workspace_lock(),
            #[cfg(test)]
            after_fetch: None,
        }
    }

    fn lock_local(&self) -> GitResult<MutexGuard<'_, ()>> {
        self.lock
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())
    }

    /// GitHub 토큰으로 HTTPS 인증 헤더를 만든다 (actions/checkout과 같은 방식).
    pub fn auth_header_for_token(token: &str) -> String {
        format!(
            "AUTHORIZATION: basic {}",
            crate::fs_io::base64_encode(format!("x-access-token:{token}").as_bytes())
        )
    }

    fn run(&self, args: &[&str]) -> GitResult<(bool, String, String)> {
        let (ok, stdout, stderr) = self.run_bytes(args)?;
        Ok((ok, String::from_utf8_lossy(&stdout).into_owned(), stderr))
    }

    /// 모든 git 호출의 공통 설정. 토큰이 없거나 만료됐을 때 git이 자격증명
    /// 입력을 기다리며 멈추지 않도록 프롬프트류를 전부 차단한다.
    fn base_cmd(&self) -> Command {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root);
        // rebase --continue 등이 에디터를 띄우지 않게 한다
        cmd.env("GIT_EDITOR", "true");
        // 인증 실패 시 터미널/GUI 프롬프트 대신 즉시 에러가 나게 한다
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GCM_INTERACTIVE", "never");
        cmd.env_remove("GIT_ASKPASS");
        // 인증 헤더는 원격 통신 명령에만 의미가 있지만 항상 끼워도 무해하다
        if let Some(header) = &self.auth_header {
            cmd.args([
                "-c",
                &format!("http.https://github.com/.extraheader={header}"),
            ]);
        }
        cmd
    }

    /// stdout을 바이트 그대로 돌려주는 변형 (`git show :N:경로`로 바이너리
    /// 스테이지 내용을 읽을 때 손상되지 않도록). 로컬/원격 실행을 디스패치한다.
    fn run_bytes(&self, args: &[&str]) -> GitResult<(bool, Vec<u8>, String)> {
        match &self.exec {
            GitExec::Local => {
                let mut cmd = self.base_cmd();
                cmd.args(args);
                run_command(cmd, network_timeout_for(args))
            }
            GitExec::Remote(session) => {
                // 원격 git은 원격 호스트의 자격증명(원격 ~/.ssh·credential helper)을
                // 쓴다. 로컬 GitHub 토큰(auth_header)은 원격에 전달하지 않는다.
                let envs = [
                    ("GIT_EDITOR", "true"),
                    ("GIT_TERMINAL_PROMPT", "0"),
                    ("GCM_INTERACTIVE", "never"),
                ];
                let root = self.root.to_string_lossy();
                let command = crate::ssh::remote_git_command(&root, &envs, args);
                let (ok, stdout, stderr) = session.exec(&command).map_err(|e| e.to_string())?;
                Ok((ok, stdout, String::from_utf8_lossy(&stderr).into_owned()))
            }
        }
    }

    fn run_ok(&self, args: &[&str]) -> GitResult<String> {
        let (ok, stdout, stderr) = self.run(args)?;
        if ok {
            Ok(stdout)
        } else {
            Err(format!(
                "git {} 실패: {}",
                args.first().unwrap_or(&""),
                stderr.trim()
            ))
        }
    }

    pub fn git_available() -> bool {
        let mut cmd = Command::new("git");
        cmd.arg("--version");
        suppress_console_window(&mut cmd);
        cmd.output().is_ok()
    }

    pub fn is_repo(&self) -> bool {
        self.run(&["rev-parse", "--is-inside-work-tree"])
            .map(|(ok, out, _)| ok && out.trim() == "true")
            .unwrap_or(false)
    }

    fn has_remote(&self) -> bool {
        self.run(&["remote", "get-url", "origin"])
            .map(|(ok, _, _)| ok)
            .unwrap_or(false)
    }

    fn current_branch(&self) -> GitResult<String> {
        Ok(self
            .run_ok(&["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string())
    }

    fn is_dirty(&self) -> GitResult<bool> {
        Ok(!self.run_ok(&["status", "--porcelain"])?.trim().is_empty())
    }

    /// git을 처음 쓰는 사용자를 위해 리포지토리 로컬 identity를 보장한다 (FR-4.8)
    fn ensure_identity(&self) -> GitResult<()> {
        let (has_name, _, _) = self.run(&["config", "user.name"])?;
        if !has_name {
            self.run_ok(&["config", "user.name", "Synapse"])?;
        }
        let (has_email, _, _) = self.run(&["config", "user.email"])?;
        if !has_email {
            self.run_ok(&["config", "user.email", "synapse@localhost"])?;
        }
        Ok(())
    }

    /// 변경 사항이 있으면 전부 커밋한다. 커밋했으면 true.
    pub fn commit_all(&self, message: &str) -> GitResult<bool> {
        if !self.is_dirty()? {
            return Ok(false);
        }
        self.ensure_identity()?;
        self.run_ok(&["add", "-A"])?;
        self.run_ok(&["commit", "-m", message])?;
        Ok(true)
    }

    /// 워크스페이스를 git 리포지토리로 만들고 원격에 첫 push 한다 (FR-4.2)
    pub fn publish(&self, remote_url: &str, message: &str) -> GitResult<SyncStatus> {
        if !self.is_repo() {
            self.run_ok(&["init", "-b", "main"])?;
        }
        self.ensure_identity()?;
        if self.has_remote() {
            self.run_ok(&["remote", "set-url", "origin", remote_url])?;
        } else {
            self.run_ok(&["remote", "add", "origin", remote_url])?;
        }
        self.run_ok(&["add", "-A"])?;
        // 빈 폴더도 unborn HEAD가 남지 않도록 첫 커밋을 보장한다
        self.run_ok(&["commit", "--allow-empty", "-m", message])?;
        let branch = self.current_branch()?;
        self.run_ok(&["push", "-u", "origin", &branch])?;
        Ok(SyncStatus::simple(SyncState::Synced))
    }

    /// 원격 리포지토리를 받아온다. dest는 새로 만들 폴더 경로.
    pub fn clone(url: &str, dest: &Path, auth_header: Option<String>) -> GitResult<PathBuf> {
        let parent = dest
            .parent()
            .ok_or_else(|| "대상 경로에 부모 폴더가 없습니다".to_string())?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let helper = GitWorkspace::new(parent, auth_header);
        helper.run_ok(&["clone", url, &dest.display().to_string()])?;
        Ok(dest.to_path_buf())
    }

    /// 네트워크 없이 현재 로컬 상태만 본다 (상태바 폴링용)
    pub fn status(&self) -> SyncStatus {
        if !Self::git_available() {
            return SyncStatus::simple(SyncState::NoGit);
        }
        if !self.is_repo() {
            return SyncStatus::simple(SyncState::NoRepo);
        }
        if !self.has_remote() {
            return SyncStatus::simple(SyncState::NoRemote);
        }
        let dirty = self.is_dirty().unwrap_or(false);
        let (ahead, behind) = self.ahead_behind().unwrap_or((0, 0));
        if dirty || ahead > 0 || behind > 0 {
            SyncStatus {
                state: SyncState::Pending,
                ahead,
                behind,
                conflict_files: vec![],
                message: None,
            }
        } else {
            SyncStatus::simple(SyncState::Synced)
        }
    }

    fn upstream(&self) -> GitResult<String> {
        Ok(format!("origin/{}", self.current_branch()?))
    }

    fn ahead_behind(&self) -> GitResult<(u32, u32)> {
        let upstream = self.upstream()?;
        let (ok, out, _) = self.run(&[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{upstream}"),
        ])?;
        if !ok {
            return Ok((0, 0)); // 업스트림 없음 (첫 push 전)
        }
        let mut parts = out.split_whitespace();
        let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok((ahead, behind))
    }

    /// commit → fetch → merge → push 한 사이클 (FR-4.3/4.4).
    ///
    /// 디스크가 유일한 진실: 병합 전 무조건 커밋해 로컬 편집을 보존하고,
    /// 업스트림과 갈라졌으면 merge 커밋으로 수렴시킨다. 텍스트 충돌은
    /// `auto_resolve_merge`가 문자 단위 3-way 병합으로 자동 해소하며,
    /// 자동 해소가 불가능한 충돌(삭제/수정 등)만 abort 후 Conflict로 보고한다.
    pub fn sync(&self, commit_message: &str) -> GitResult<SyncStatus> {
        if !Self::git_available() {
            return Ok(SyncStatus::simple(SyncState::NoGit));
        }
        if !self.is_repo() {
            return Ok(SyncStatus::simple(SyncState::NoRepo));
        }
        if !self.has_remote() {
            return Ok(SyncStatus::simple(SyncState::NoRemote));
        }
        // 로컬 구간 (락): 잔재 정리 + 병합 전 커밋(= 소실 방지 불변식)
        {
            let _guard = self.lock_local()?;
            self.heal_in_progress()?;
            self.commit_all(commit_message)?;
        }
        // 잔재 치유는 루프 밖 한 번이면 충분하다: 루프 안의 병합은 깨끗이
        // 완결되거나(자동 해소 포함) abort 후 곧장 반환되므로, 시도 사이에
        // 새 잔재가 생길 수 없다.
        for _attempt in 0..3 {
            // 네트워크 구간 (락 없음): fetch 동안 저장이 막히지 않는다
            self.run_ok(&["fetch", "origin"])?;
            #[cfg(test)]
            if let Some(hook) = &self.after_fetch {
                hook();
            }
            // 로컬 구간 (락): merge + 자동 해소
            {
                let _guard = self.lock_local()?;
                // fetch 동안 들어온 저장을 먼저 커밋해 병합에 깨끗한 트리를 보장
                self.commit_all(commit_message)?;
                let upstream = self.upstream()?;
                let (upstream_exists, _, _) =
                    self.run(&["rev-parse", "--verify", &format!("{upstream}^{{commit}}")])?;
                if upstream_exists {
                    let (_, behind) = self.ahead_behind()?;
                    if behind > 0 {
                        let (ok, _, merge_err) = self.run(&["merge", "--no-edit", &upstream])?;
                        if !ok && self.auto_resolve_merge().is_err() {
                            let files = self.conflicted_files()?;
                            let _ = self.run(&["merge", "--abort"]);
                            if files.is_empty() {
                                // merge가 시작조차 못 한 경우(미추적 파일 덮어쓰기
                                // 등) — 빈 충돌 목록으로 오도하지 말고 git의 원인을
                                // 그대로 알린다
                                return Err(format!("git merge 실패: {}", merge_err.trim()));
                            }
                            return Ok(SyncStatus {
                                state: SyncState::Conflict,
                                ahead: 0,
                                behind,
                                conflict_files: files,
                                message: None,
                            });
                        }
                    }
                }
            }
            // 네트워크 구간 (락 없음): push는 워킹트리를 만지지 않는다
            let branch = self.current_branch()?;
            let (pushed, _, _) = self.run(&["push", "-u", "origin", &branch])?;
            if pushed {
                return Ok(SyncStatus::simple(SyncState::Synced));
            }
            // push 레이스: 그 사이 원격이 갱신됨 → fetch부터 재시도
        }
        // 3회 재시도로도 push 못 함 → pending 유지(다음 주기에 재시도)
        Ok(SyncStatus::simple(SyncState::Pending))
    }

    /// 중단된 merge/rebase 잔재를 정리해 sync가 깨끗한 상태에서 시작하도록
    /// 자가 치유한다.
    ///
    /// 소실 방지 불변식을 지키기 위해 **캡처 → abort → 복원** 순서로 진행한다:
    /// abort가 워킹트리를 HEAD로 되돌리기 전에 더티 상태(미커밋 편집 포함)를
    /// 통째로 떠 두고, abort 후 그대로 되돌린다. 직후의 commit_all이 치유 전
    /// 디스크 상태를 일반(단일 부모) 커밋으로 보존하므로 잔재 병합이 실수로
    /// 완결되는 일도, 사용자 바이트가 사라지는 일도 없다. abort가 끝내
    /// 실패하면 Err — 낡은 병합을 완결해 버릴 sync로 진행하지 않는다.
    fn heal_in_progress(&self) -> GitResult<()> {
        let merge_leftover = self.merge_in_progress()?;
        let rebase_merge_dir = self.run_ok(&["rev-parse", "--git-path", "rebase-merge"])?;
        let rebase_apply_dir = self.run_ok(&["rev-parse", "--git-path", "rebase-apply"])?;
        let rebase_dir_exists = || {
            self.backend
                .exists(&self.root.join(rebase_merge_dir.trim()))
                || self
                    .backend
                    .exists(&self.root.join(rebase_apply_dir.trim()))
        };
        let rebase_leftover = rebase_dir_exists();
        if !merge_leftover && !rebase_leftover {
            return Ok(());
        }
        // 1) 캡처: abort가 워킹트리를 되돌리기 전, 지금 이 순간의 디스크 상태
        let captured = self.capture_dirty_state()?;
        // 2) abort (결과 확인). 더티 트리에서 abort가 거부되면 캡처를 믿고
        //    reset --hard로 밀어낸다 — 모든 더티 바이트가 캡처돼 있어 안전하다.
        let abort_result = (|| -> GitResult<()> {
            if merge_leftover {
                let (ok, _, _) = self.run(&["merge", "--abort"])?;
                if !ok {
                    self.run_ok(&["reset", "--hard", "HEAD"])?;
                    if self.merge_in_progress()? {
                        let _ = self.run(&["merge", "--abort"]);
                    }
                }
                if self.merge_in_progress()? {
                    return Err("남은 병합 상태를 정리하지 못했습니다".to_string());
                }
            }
            if rebase_leftover {
                let (ok, _, _) = self.run(&["rebase", "--abort"])?;
                if !ok {
                    self.run_ok(&["reset", "--hard", "HEAD"])?;
                    let _ = self.run(&["rebase", "--abort"]);
                }
                if rebase_dir_exists() {
                    return Err("남은 rebase 상태를 정리하지 못했습니다".to_string());
                }
            }
            Ok(())
        })();
        // 3) 복원: 파괴적 단계(abort/reset) 이후에는 성공·실패와 무관하게
        //    캡처를 최선으로 되돌린다 — Err로 나가더라도 사용자 바이트는
        //    디스크에 남는다 (직후 commit_all이 이걸 커밋한다).
        let restore_result = self.restore_dirty_state(&captured);
        abort_result?;
        restore_result
    }

    /// 워킹트리의 더티 상태를 통째로 떠 둔다: 경로마다 현재 바이트(파일이
    /// 있으면) 또는 삭제 표시(워킹트리에서 지워졌으면). heal의 abort가
    /// 워킹트리를 HEAD로 되돌려도 이 스냅샷을 복원하면 한 바이트도 잃지 않는다.
    fn capture_dirty_state(&self) -> GitResult<Vec<(String, Option<Vec<u8>>)>> {
        // -z: 경로 인용/이스케이프 없이 NUL 구분 — 공백·비ASCII 경로 안전
        let (ok, out, err) = self.run_bytes(&["status", "--porcelain", "-z"])?;
        if !ok {
            return Err(format!("git status 실패: {}", err.trim()));
        }
        let out = String::from_utf8_lossy(&out).into_owned();
        let mut fields = out.split('\0').filter(|s| !s.is_empty());
        let mut captured = Vec::new();
        while let Some(entry) = fields.next() {
            if entry.len() < 4 {
                continue; // "XY 경로" 최소 길이 미달 — 형식 밖 항목은 무시
            }
            let (status, path) = entry.split_at(3);
            // rename/copy는 다음 필드가 원래 경로 — 새 경로만 캡처하면 충분하다
            if status.starts_with('R') || status.starts_with('C') {
                let _ = fields.next();
            }
            if path.ends_with('/') {
                continue; // 미추적 디렉터리 — abort가 건드리지 않는다
            }
            let abs = self.root.join(path);
            let content = if self.backend.exists(&abs) {
                let bytes = self.backend.read(&abs).map_err(|e| e.to_string())?;
                // 잔재 충돌 파일(UU/AA)의 내용이 git이 쓴 충돌 마커 출력
                // 그대로라면 사용자 데이터가 아니다 — 복원하지 않아야 마커가
                // 노트로 커밋되어 퍼지지 않는다 (실제 내용은 양쪽 부모 커밋에
                // 안전하다). 사용자가 그 위에 편집했다면 내용이 달라 이 판별을
                // 통과하지 못하므로 평소대로 캡처·복원한다 (보존 우선).
                if (status.starts_with("UU") || status.starts_with("AA"))
                    && self.is_git_authored_conflict(path, &bytes)
                {
                    continue;
                }
                Some(bytes)
            } else {
                None // 워킹트리에서 삭제됨 — 복원 시 다시 삭제해 상태를 보존
            };
            captured.push((path.to_string(), content));
        }
        Ok(captured)
    }

    /// 충돌 파일의 현재 워킹트리 바이트가 git이 만든 충돌 마커 출력
    /// 그대로인지(= 사용자가 그 위에 편집하지 않았는지) 판별한다.
    /// `git checkout -m`으로 인덱스 스테이지에서 git의 마커 출력을 재생성해
    /// 비교한다 — 마커 라벨(`HEAD`/`ours` 등)은 재생성 시 달라질 수 있어
    /// 라벨을 지운 형태로 비교한다. 판별이 실패하면 보수적으로 사용자
    /// 편집으로 간주한다 (보존이 이긴다). 워킹트리 파일은 재생성으로
    /// 덮어써지지만, 호출 전에 원본이 캡처되어 있고 직후의 abort/복원이
    /// 상태를 정리하므로 안전하다.
    fn is_git_authored_conflict(&self, path: &str, current: &[u8]) -> bool {
        let Ok(current) = std::str::from_utf8(current) else {
            return false; // 바이너리는 마커 출력이 아니다
        };
        let Ok((ok, _, _)) = self.run(&["checkout", "-m", "--", path]) else {
            return false;
        };
        if !ok {
            return false;
        }
        let Ok(regenerated) = self.backend.read(&self.root.join(path)) else {
            return false;
        };
        normalize_conflict_markers(current)
            == normalize_conflict_markers(&String::from_utf8_lossy(&regenerated))
    }

    /// `capture_dirty_state` 스냅샷을 워킹트리에 그대로 되돌린다.
    /// 개별 항목 실패에도 나머지를 끝까지 시도하고(최선 노력) 첫 에러를
    /// 돌려준다 — 한 파일의 실패가 다른 파일의 복원을 막지 않는다.
    fn restore_dirty_state(&self, captured: &[(String, Option<Vec<u8>>)]) -> GitResult<()> {
        let mut first_err = None;
        for (path, content) in captured {
            let abs = self.root.join(path);
            let result = match content {
                Some(bytes) => {
                    if let Some(parent) = abs.parent() {
                        let _ = self.backend.create_dir_all(parent);
                    }
                    self.backend.write(&abs, bytes).map_err(|e| e.to_string())
                }
                None => {
                    if self.backend.exists(&abs) {
                        self.backend.remove_file(&abs).map_err(|e| e.to_string())
                    } else {
                        Ok(())
                    }
                }
            };
            if let Err(e) = result {
                first_err.get_or_insert(e);
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// 진행 중인 merge가 있는지 (MERGE_HEAD 존재).
    fn merge_in_progress(&self) -> GitResult<bool> {
        let merge_head = self.run_ok(&["rev-parse", "--git-path", "MERGE_HEAD"])?;
        Ok(self.backend.exists(&self.root.join(merge_head.trim())))
    }

    /// 충돌 스테이지(:1: base, :2: ours, :3: theirs)의 내용. 해당 스테이지가
    /// 없으면(삭제 등) None.
    fn stage_bytes(&self, stage: u8, path: &str) -> GitResult<Option<Vec<u8>>> {
        let spec = format!(":{stage}:{path}");
        let (ok, out, _) = self.run_bytes(&["show", &spec])?;
        Ok(ok.then_some(out))
    }

    /// 진행 중인 merge의 충돌을 파일별 규칙으로 자동 해소하고 병합 커밋을
    /// 완결한다. 텍스트는 문자 단위 3-way 병합(양쪽 편집 보존), 바이너리와
    /// `.synapse/draw/` 주석 사이드카는 양쪽 보존(theirs가 원래 이름, ours는
    /// conflict 사본), 그 밖의 `.synapse/`(레거시)는 삭제로 해소한다.
    /// 자동 해소 대상이 아니면(삭제/수정) Err — 호출자가 abort 후 Conflict로
    /// 보고한다(3택 UI 폴백).
    fn auto_resolve_merge(&self) -> GitResult<()> {
        let data_prefix = format!("{DATA_DIR}/");
        let draw_prefix = format!("{DATA_DIR}/draw/");
        for path in self.conflicted_files()? {
            let is_draw = path.starts_with(&draw_prefix);
            // `.synapse/` 밑 충돌은 마이그레이션 과도기 동안 삭제로 해소한다
            // (다른 기기가 아직 레거시 CRDT 파일을 쓸 수 있으므로 git rm으로
            // 없앤다). 예외: `.synapse/draw/`는 살아 있는 PDF 주석 데이터
            // (pdf-draw 사이드카)이므로 삭제하지 않고 아래 keep-both로 보존한다.
            if path.starts_with(&data_prefix) && !is_draw {
                self.run_ok(&["rm", "-f", "--", &path])?;
                continue;
            }
            let base = self.stage_bytes(1, &path)?;
            let ours = self.stage_bytes(2, &path)?;
            let theirs = self.stage_bytes(3, &path)?;
            match (ours, theirs) {
                (Some(o), Some(t)) if is_draw => {
                    // draw 사이드카는 JSON이라 문자 단위 병합이 포맷을 깨뜨릴 수
                    // 있다 — keep-both가 양쪽을 유효한 JSON으로 보존한다
                    // (원본=theirs, 사본은 히스토리/수동 복구용).
                    self.keep_both(&path, &o, &t)?;
                }
                (Some(o), Some(t)) => match (std::str::from_utf8(&o), std::str::from_utf8(&t)) {
                    (Ok(os), Ok(ts)) => {
                        // 텍스트: 결정적 문자 단위 3-way 병합 (어느 기기가 해도 같은 결과)
                        let bs = base
                            .as_deref()
                            .map(|b| String::from_utf8_lossy(b).into_owned())
                            .unwrap_or_default();
                        let merged = crate::merge::merge_three_way(&bs, os, ts);
                        self.backend
                            .write(&self.root.join(&path), merged.as_bytes())
                            .map_err(|e| e.to_string())?;
                        self.run_ok(&["add", "--", &path])?;
                    }
                    _ => {
                        // 바이너리: 둘 다 보존 (theirs가 원래 이름, ours는 conflict 사본)
                        self.keep_both(&path, &o, &t)?;
                    }
                },
                // 삭제/수정 충돌은 자동 해결하지 않는다 → 3택 UI로 폴백
                _ => return Err(format!("삭제/수정 충돌은 자동 해결하지 않습니다: {path}")),
            }
        }
        // 병합 커밋 완결. 자동 해소 결과가 HEAD와 동일한 트리를 낳으면 커밋할
        // 것이 없어 실패하는데, 그때는 빈 병합 커밋으로 완결해 업스트림을
        // 조상으로 남기고 push가 fast-forward 되게 한다.
        let (ok, _, err) = self.run(&["commit", "--no-edit"])?;
        if !ok {
            if self.merge_in_progress()? {
                let (ok2, _, err2) = self.run(&["commit", "--no-edit", "--allow-empty"])?;
                if !ok2 {
                    return Err(format!("병합 커밋 실패: {}", err2.trim()));
                }
            } else {
                return Err(format!("병합 커밋 실패: {}", err.trim()));
            }
        }
        Ok(())
    }

    /// 충돌 양쪽을 모두 보존하고 스테이징한다: theirs가 원래 이름을 차지하고,
    /// ours는 "이름 (conflict).ext" 사본으로 남는다.
    fn keep_both(&self, path: &str, ours: &[u8], theirs: &[u8]) -> GitResult<()> {
        let copy = conflict_copy_name(path);
        self.backend
            .write(&self.root.join(&copy), ours)
            .map_err(|e| e.to_string())?;
        self.backend
            .write(&self.root.join(path), theirs)
            .map_err(|e| e.to_string())?;
        self.run_ok(&["add", "--", path, &copy])?;
        Ok(())
    }

    fn conflicted_files(&self) -> GitResult<Vec<String>> {
        Ok(self
            .run_ok(&["diff", "--name-only", "--diff-filter=U"])?
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// 충돌을 3택 전략으로 해소하고 push까지 마친다 (FR-4.5 MVP)
    pub fn resolve_conflicts(&self, choice: ConflictChoice) -> GitResult<SyncStatus> {
        {
            let _guard = self.lock_local()?;
            self.commit_all("synapse: 충돌 해결 전 저장")?;
        }
        self.run_ok(&["fetch", "origin"])?;
        let upstream = self.upstream()?;

        let guard = self.lock_local()?;
        match choice {
            ConflictChoice::KeepMine => {
                // rebase에서 -Xtheirs는 "재생되는 커밋"(= 내 로컬 변경)을 우선한다
                self.run_ok(&["rebase", "-Xtheirs", &upstream])?;
            }
            ConflictChoice::KeepRemote => {
                self.run_ok(&["rebase", "-Xours", &upstream])?;
            }
            ConflictChoice::KeepBoth => {
                // 1) 충돌 파일의 내 버전을 미리 떠 둔다
                let (ok, _, _) = self.run(&["rebase", &upstream])?;
                let files = if ok {
                    vec![] // 그 사이 충돌이 사라짐
                } else {
                    let f = self.conflicted_files()?;
                    self.run_ok(&["rebase", "--abort"])?;
                    f
                };
                let saved: Vec<(String, String)> = files
                    .iter()
                    .filter_map(|f| {
                        self.run_ok(&["show", &format!("HEAD:{f}")])
                            .ok()
                            .map(|content| (f.clone(), content))
                    })
                    .collect();
                // 2) 원격 우선으로 rebase
                self.run_ok(&["rebase", "-Xours", &upstream])?;
                // 3) 내 버전을 "이름 (conflict).ext"로 보존
                for (file, content) in saved {
                    let conflict_name = conflict_copy_name(&file);
                    self.backend
                        .write(&self.root.join(&conflict_name), content.as_bytes())
                        .map_err(|e| e.to_string())?;
                }
                self.commit_all("synapse: 충돌한 내 버전을 (conflict) 사본으로 보존")?;
            }
        }
        drop(guard);
        let branch = self.current_branch()?;
        self.run_ok(&["push", "-u", "origin", &branch])?;
        Ok(SyncStatus::simple(SyncState::Synced))
    }

    /// 충돌한 파일들의 양쪽 내용을 모아 돌려준다 (FR-4.5 diff 뷰).
    ///
    /// 충돌이 감지되면 rebase가 중단(abort)되어 워킹트리는 깨끗하다. 따라서
    /// 내 버전은 로컬 `HEAD`, 원격 버전은 업스트림 ref에서 읽는다. 최신 원격을
    /// 반영하기 위해 먼저 fetch 한다. 어느 한쪽에서 삭제된 파일은 None이 된다.
    pub fn conflict_preview(&self) -> GitResult<Vec<ConflictPreview>> {
        if !Self::git_available() || !self.is_repo() {
            return Ok(vec![]);
        }
        // 업스트림 내용을 정확히 보려면 최신 상태로 fetch (락 불필요: 워킹트리 안 만짐)
        let _ = self.run(&["fetch", "origin"]);
        let upstream = self.upstream()?;

        // 충돌 대상 파일 = 로컬과 업스트림이 공통 조상 이후로 함께 바뀐 파일.
        // merge-base 대비 양쪽 diff의 교집합을 쓴다. merge-base가 없으면 빈 목록.
        let (ok, base, _) = self.run(&["merge-base", "HEAD", &upstream])?;
        if !ok {
            return Ok(vec![]);
        }
        let base = base.trim().to_string();
        let mine_changed = self.changed_files(&base, "HEAD")?;
        let theirs_changed = self.changed_files(&base, &upstream)?;

        let mut files: Vec<String> = mine_changed
            .iter()
            .filter(|f| theirs_changed.contains(*f))
            // .synapse 내부 CRDT 로그 등은 사용자에게 보여줄 diff가 아니다
            .filter(|f| !f.starts_with(DATA_DIR))
            .cloned()
            .collect();
        files.sort();
        files.dedup();

        Ok(files
            .into_iter()
            .map(|path| {
                let mine = self
                    .run(&["show", &format!("HEAD:{path}")])
                    .ok()
                    .and_then(|(ok, out, _)| ok.then_some(out));
                let theirs = self
                    .run(&["show", &format!("{upstream}:{path}")])
                    .ok()
                    .and_then(|(ok, out, _)| ok.then_some(out));
                ConflictPreview { path, mine, theirs }
            })
            .collect())
    }

    /// `from..to` 사이에 변경된 파일 경로 목록.
    fn changed_files(&self, from: &str, to: &str) -> GitResult<Vec<String>> {
        Ok(self
            .run_ok(&["diff", "--name-only", &format!("{from}..{to}")])?
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// 한 파일의 git 커밋 히스토리 (최신순). 레포가 아니거나 추적되지 않는
    /// 파일이면 빈 목록을 돌려준다 — 앱이 죽지 않게 우아하게 처리한다 (FR-4.7).
    ///
    /// `rel_path`는 워크스페이스 루트 기준 상대 경로(git pathspec)다.
    pub fn file_history(&self, rel_path: &str) -> GitResult<Vec<FileCommit>> {
        if !Self::git_available() || !self.is_repo() {
            return Ok(vec![]);
        }
        // 레코드/필드 구분자로 잘 안 쓰이는 제어문자를 써서 메시지에 개행이
        // 있어도 안전하게 파싱한다. %x1e=레코드, %x1f=필드.
        // 이름이 바뀐 이력까지 따라가도록 --follow.
        let (ok, out, _) = self.run(&[
            "log",
            "--follow",
            "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%B%x1e",
            "--",
            rel_path,
        ])?;
        if !ok {
            // pathspec이 매치 안 되는 등(추적 안 됨) — 빈 히스토리로 본다
            return Ok(vec![]);
        }
        Ok(parse_file_history(&out))
    }

    /// 특정 리비전 시점의 파일 내용. `git show <rev>:<path>` 류.
    /// 해당 리비전에 파일이 없으면 에러를 돌려준다.
    pub fn file_at_revision(&self, rel_path: &str, rev: &str) -> GitResult<String> {
        if !Self::git_available() {
            return Err("git이 설치되어 있지 않습니다".to_string());
        }
        if !self.is_repo() {
            return Err("git 리포지토리가 아닙니다".to_string());
        }
        // rev에 ':'가 섞여 들어와 pathspec을 교란하지 못하도록 분리 인자로 넘긴다.
        let spec = format!("{rev}:{rel_path}");
        let (ok, out, err) = self.run(&["show", &spec])?;
        if ok {
            Ok(out)
        } else {
            Err(format!("해당 버전을 불러올 수 없습니다: {}", err.trim()))
        }
    }
}

/// `git log` 출력을 FileCommit 목록으로 파싱한다 (순수 함수 — 단위 테스트 대상).
fn parse_file_history(raw: &str) -> Vec<FileCommit> {
    raw.split('\u{1e}')
        .filter_map(|rec| {
            let rec = rec.trim_matches(|c: char| c == '\n' || c == '\r');
            if rec.is_empty() {
                return None;
            }
            let mut fields = rec.split('\u{1f}');
            let hash = fields.next()?.trim().to_string();
            let short_hash = fields.next()?.trim().to_string();
            let author = fields.next()?.trim().to_string();
            let timestamp = fields.next()?.trim().to_string();
            // 메시지는 %B(개행 포함 본문) — 마지막 필드라 안쪽 줄바꿈은 보존하고
            // 양끝 공백만 다듬는다.
            let message = fields.next().unwrap_or("").trim().to_string();
            if hash.is_empty() {
                return None;
            }
            Some(FileCommit {
                hash,
                short_hash,
                author,
                timestamp,
                message,
            })
        })
        .collect()
}

/// 충돌 마커 라벨을 지운 비교용 형태 (`<<<<<<< HEAD` → `<<<<<<<`).
/// merge와 checkout -m이 같은 충돌에 서로 다른 라벨(HEAD/origin·ours/theirs)을
/// 붙이므로, 라벨만 다른 동일한 git 마커 출력을 같은 것으로 비교하게 한다.
fn normalize_conflict_markers(text: &str) -> String {
    text.lines()
        .map(|line| {
            for marker in ["<<<<<<<", ">>>>>>>", "|||||||"] {
                if line.starts_with(marker) {
                    return marker;
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// "dir/note.md" → "dir/note (conflict).md"
fn conflict_copy_name(path: &str) -> String {
    match path.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (conflict).{ext}"),
        _ => format!("{path} (conflict)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bare 원격 + 워크스페이스 하나를 만든다
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let out = Command::new("git")
            .args([
                "init",
                "--bare",
                "-b",
                "main",
                &remote.display().to_string(),
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        let ws = tmp.path().join("workspace");
        fs::create_dir(&ws).unwrap();
        (tmp, remote, ws)
    }

    /// bare 원격 + 두 클론(a: publish 후, b: clone)을 만든다.
    /// `changes_propagate_between_two_clones` 관용구를 헬퍼로 뽑은 것.
    fn setup_two_clones() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();
        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        // 클론본에도 로컬 identity를 보장한다 (raw git 커밋·병합 커밋용)
        assert!(git_raw(&ws_b, &["config", "user.name", "Tester"]));
        assert!(git_raw(
            &ws_b,
            &["config", "user.email", "tester@example.com"]
        ));
        (tmp, ws_a, ws_b)
    }

    fn ws(root: &Path) -> GitWorkspace {
        GitWorkspace::new(root, None)
    }

    fn write(dir: &Path, name: &str, content: &str) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn write_bytes(dir: &Path, name: &str, content: &[u8]) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn read(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).unwrap()
    }

    fn read_bytes(dir: &Path, name: &str) -> Vec<u8> {
        fs::read(dir.join(name)).unwrap()
    }

    /// 워크스페이스에서 raw git 명령을 돌린다 (테스트 셋업 전용). 성공 여부 반환.
    fn git_raw(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success()
    }

    #[test]
    fn publish_then_status_synced() {
        let (_tmp, remote, ws) = setup();
        write(&ws, "note.md", "# 첫 노트");
        let git = GitWorkspace::new(&ws, None);
        assert_eq!(git.status().state, SyncState::NoRepo);

        let status = git
            .publish(&remote.display().to_string(), "synapse: 초기 게시")
            .unwrap();
        assert_eq!(status.state, SyncState::Synced);
        assert_eq!(git.status().state, SyncState::Synced);
    }

    #[test]
    fn status_pending_when_dirty_and_synced_after_sync() {
        let (_tmp, remote, ws) = setup();
        let git = GitWorkspace::new(&ws, None);
        git.publish(&remote.display().to_string(), "init").unwrap();

        write(&ws, "note.md", "수정");
        assert_eq!(git.status().state, SyncState::Pending);
        assert_eq!(
            git.sync("synapse: update").unwrap().state,
            SyncState::Synced
        );
        assert_eq!(git.status().state, SyncState::Synced);
    }

    #[test]
    fn changes_propagate_between_two_clones() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "A의 첫 내용");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);
        assert_eq!(read(&ws_b, "shared.md"), "A의 첫 내용");

        write(&ws_b, "shared.md", "B가 고침");
        git_b.sync("B update").unwrap();
        git_a.sync("A pull").unwrap();
        assert_eq!(read(&ws_a, "shared.md"), "B가 고침");
    }

    #[test]
    fn conflict_detected_and_repo_left_clean() {
        // 삭제/수정 충돌은 자동 해소 대상이 아니므로 merge --abort 후 Conflict로
        // 보고되고 워크스페이스는 깨끗한 상태(내 버전)로 남아야 한다.
        let (_tmp, ws_a, ws_b) = setup_two_clones();
        write(&ws_a, "shared.md", "기준 내용");
        ws(&ws_a).sync("init").unwrap();
        ws(&ws_b).sync("pull").unwrap();

        // A는 파일을 삭제, B는 같은 파일을 수정 → 삭제/수정 충돌
        fs::remove_file(ws_a.join("shared.md")).unwrap();
        ws(&ws_a).sync("A 삭제").unwrap();
        write(&ws_b, "shared.md", "B의 수정");
        let status = ws(&ws_b).sync("B").unwrap();

        assert_eq!(status.state, SyncState::Conflict);
        assert_eq!(status.conflict_files, vec!["shared.md"]);
        // merge --abort 되어 충돌 마커 없이 내 내용 그대로여야 한다
        assert_eq!(read(&ws_b, "shared.md"), "B의 수정");
    }

    #[test]
    fn conflict_preview_returns_both_sides() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "기준 내용");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);

        write(&ws_a, "shared.md", "A의 수정");
        git_a.sync("A").unwrap();
        // B는 로컬 커밋만 남기고 갈라진 상태로 둔다 (conflict_preview는 진행 중인
        // 충돌 상태를 요구하지 않고 HEAD 대 업스트림 diff로 계산한다)
        write(&ws_b, "shared.md", "B의 수정");
        git_b.commit_all("B").unwrap();

        // diff 뷰: 내 버전(B)과 원격 버전(A)을 모두 읽어 와야 한다
        let preview = git_b.conflict_preview().unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].path, "shared.md");
        assert_eq!(preview[0].mine.as_deref(), Some("B의 수정"));
        assert_eq!(preview[0].theirs.as_deref(), Some("A의 수정"));
    }

    #[test]
    fn resolve_keep_mine_wins_on_remote() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "기준");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);

        write(&ws_a, "shared.md", "A의 수정");
        git_a.sync("A").unwrap();
        // B를 갈라진 로컬 커밋으로 둔다 (resolve_conflicts가 자체 fetch+rebase 한다)
        write(&ws_b, "shared.md", "B의 수정");
        git_b.commit_all("B").unwrap();

        assert_eq!(
            git_b
                .resolve_conflicts(ConflictChoice::KeepMine)
                .unwrap()
                .state,
            SyncState::Synced
        );
        git_a.sync("A pull").unwrap();
        assert_eq!(read(&ws_a, "shared.md"), "B의 수정");
    }

    #[test]
    fn resolve_keep_remote_discards_mine() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "기준");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);

        write(&ws_a, "shared.md", "A의 수정");
        git_a.sync("A").unwrap();
        write(&ws_b, "shared.md", "B의 수정");
        git_b.commit_all("B").unwrap();

        git_b.resolve_conflicts(ConflictChoice::KeepRemote).unwrap();
        assert_eq!(read(&ws_b, "shared.md"), "A의 수정");
    }

    #[test]
    fn resolve_keep_both_preserves_local_as_conflict_copy() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "기준");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);

        write(&ws_a, "shared.md", "A의 수정");
        git_a.sync("A").unwrap();
        write(&ws_b, "shared.md", "B의 수정");
        git_b.commit_all("B").unwrap();

        git_b.resolve_conflicts(ConflictChoice::KeepBoth).unwrap();
        assert_eq!(read(&ws_b, "shared.md"), "A의 수정");
        assert_eq!(read(&ws_b, "shared (conflict).md"), "B의 수정");

        // 사본까지 원격에 반영되어 A에서도 보인다
        git_a.sync("A pull").unwrap();
        assert_eq!(read(&ws_a, "shared (conflict).md"), "B의 수정");
    }

    // ----------------------------------------------------------------
    // merge 기반 자동 수렴 + 자가 치유 (CRDT 스토어 비의존)
    // ----------------------------------------------------------------

    #[test]
    fn sync_auto_merges_concurrent_md_edits() {
        // 두 클론이 같은 파일을 다르게 편집 → 양쪽 sync가 충돌 없이 수렴
        let (_tmp, a, b) = setup_two_clones();
        write(&a, "note.md", "# 노트\n\n공통 문단입니다.\n");
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();
        write(&a, "note.md", "# 노트\n\n공통 문단입니다. A의 추가.\n");
        write(&b, "note.md", "B의 서두. \n\n# 노트\n\n공통 문단입니다.\n");
        ws(&a).sync("a").unwrap();
        let st = ws(&b).sync("b").unwrap();
        assert_eq!(st.state, SyncState::Synced);
        let merged = read(&b, "note.md");
        assert!(merged.contains("A의 추가"), "A의 편집 유실: {merged}");
        assert!(merged.contains("B의 서두"), "B의 편집 유실: {merged}");
        // A가 다시 sync하면 동일 내용으로 수렴 (재발산 없음)
        ws(&a).sync("a2").unwrap();
        assert_eq!(read(&a, "note.md"), merged);
    }

    #[test]
    fn sync_heals_leftover_merge_state() {
        // MERGE_HEAD 잔재가 있어도 sync가 스스로 정리하고 진행한다
        let (_tmp, a, b) = setup_two_clones();
        write(&a, "note.md", "# 제목\n\n공통 본문\n");
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        // A는 제목 줄, B는 끝에 문단을 추가 (서로 다른 영역 → 병합은 깨끗하다)
        write(&a, "note.md", "# 제목 (A)\n\n공통 본문\n");
        ws(&a).sync("a").unwrap();
        write(&b, "note.md", "# 제목\n\n공통 본문\n\nB 추가 문단\n");

        // B에 완결되지 않은 merge를 남긴다: --no-commit이 커밋 직전에 멈춰
        // MERGE_HEAD 잔재를 남긴다 (병합 자체는 성공)
        assert!(git_raw(&b, &["add", "-A"]));
        assert!(git_raw(&b, &["commit", "-m", "B"]));
        assert!(git_raw(&b, &["fetch", "origin"]));
        assert!(git_raw(
            &b,
            &["merge", "--no-commit", "--no-ff", "origin/main"]
        ));
        assert!(b.join(".git/MERGE_HEAD").exists(), "잔재 MERGE_HEAD가 없다");

        // sync가 스스로 잔재를 정리(merge --abort)하고 다시 병합해 수렴시킨다
        let st = ws(&b).sync("recover").unwrap();
        assert_eq!(st.state, SyncState::Synced);
        let merged = read(&b, "note.md");
        assert!(merged.contains("(A)"), "A 편집 유실: {merged}");
        assert!(merged.contains("B 추가 문단"), "B 편집 유실: {merged}");
        assert_eq!(ws(&b).status().state, SyncState::Synced);
    }

    #[test]
    fn heal_preserves_uncommitted_edits_over_conflicted_leftover_merge() {
        // 충돌로 중단된 merge 잔재 + 그 충돌 파일에 대한 미커밋 사용자 편집.
        // heal이 편집을 캡처해 두었다가 abort 후 복원해 커밋으로 보존해야 한다
        // (abort가 파일을 HEAD로 되돌리며 편집을 파괴하면 안 된다).
        let (_tmp, a, b) = setup_two_clones();
        write(&a, "note.md", "# 제목\n\n공통 본문\n");
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        // 같은 제목 줄을 다르게 편집해 진짜 git 충돌을 만든다
        write(&a, "note.md", "# 제목 A\n\n공통 본문\n");
        ws(&a).sync("a").unwrap();
        write(&b, "note.md", "# 제목 B\n\n공통 본문\n");
        assert!(git_raw(&b, &["add", "-A"]));
        assert!(git_raw(&b, &["commit", "-m", "B"]));
        assert!(git_raw(&b, &["fetch", "origin"]));
        assert!(!git_raw(&b, &["merge", "origin/main"]), "충돌 없이 병합됨");
        assert!(b.join(".git/MERGE_HEAD").exists(), "잔재 MERGE_HEAD가 없다");

        // 사용자가 충돌 파일을 직접 고쳐 저장 (미커밋) — 절대 잃으면 안 되는 편집
        write(
            &b,
            "note.md",
            "# 제목 B\n\n공통 본문\n\nUSER-PRECIOUS-EDIT\n",
        );

        let st = ws(&b).sync("recover").unwrap();
        assert_eq!(st.state, SyncState::Synced);
        // 편집이 디스크에 살아 있고
        let merged = read(&b, "note.md");
        assert!(
            merged.contains("USER-PRECIOUS-EDIT"),
            "미커밋 편집 유실: {merged}"
        );
        // HEAD에서 닿는 커밋에 담겨 있다
        let hits = ws(&b)
            .run_ok(&["log", "--format=%H", "-S", "USER-PRECIOUS-EDIT"])
            .unwrap();
        assert!(!hits.trim().is_empty(), "편집이 어떤 커밋에도 없다");
    }

    #[test]
    fn heal_skips_restoring_untouched_conflict_markers() {
        // 충돌로 중단된 merge 잔재를 사용자 편집 없이 그대로 두면, 워크트리의
        // 충돌 마커는 git이 쓴 것이지 사용자 데이터가 아니다 — 복원·커밋하지
        // 않아야 `<<<<<<<` 마커가 노트로 퍼지지 않는다.
        let (_tmp, a, b) = setup_two_clones();
        write(&a, "note.md", "# 제목\n\n공통 본문\n");
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        write(&a, "note.md", "# 제목 A\n\n공통 본문\n");
        ws(&a).sync("a").unwrap();
        write(&b, "note.md", "# 제목 B\n\n공통 본문\n");
        assert!(git_raw(&b, &["add", "-A"]));
        assert!(git_raw(&b, &["commit", "-m", "B"]));
        assert!(git_raw(&b, &["fetch", "origin"]));
        assert!(!git_raw(&b, &["merge", "origin/main"]), "충돌 없이 병합됨");
        assert!(b.join(".git/MERGE_HEAD").exists(), "잔재 MERGE_HEAD가 없다");
        assert!(read(&b, "note.md").contains("<<<<<<<"), "마커가 없다");

        // 사용자 편집 없이 그대로 sync — 마커는 버려지고 병합으로 수렴해야 한다
        let st = ws(&b).sync("recover").unwrap();
        assert_eq!(st.state, SyncState::Synced);
        let merged = read(&b, "note.md");
        assert!(!merged.contains("<<<<<<<"), "충돌 마커 오염: {merged}");
        assert!(!merged.contains("======="), "충돌 마커 오염: {merged}");
        // 양쪽 편집은 자동 병합으로 보존된다 (마커 없이)
        assert!(merged.contains("공통 본문"), "본문 유실: {merged}");
        // 어떤 커밋에도 마커가 실리지 않았다
        let hits = ws(&b)
            .run_ok(&["log", "--format=%H", "-S", "<<<<<<<"])
            .unwrap();
        assert!(hits.trim().is_empty(), "마커가 커밋에 실림: {hits}");
    }

    #[test]
    fn heal_discards_stale_merge_but_keeps_dirty_edits() {
        // 깨끗한(--no-commit) merge 잔재 + 병합이 만진 파일의 unstaged 편집.
        // 이때 merge --abort는 더티 트리를 거부하지만(Entry not uptodate),
        // heal이 캡처→reset→복원으로 잔재를 버리고, 편집은 낡은 병합의 완결이
        // 아니라 일반(단일 부모) 커밋으로 보존해야 한다.
        let (_tmp, a, b) = setup_two_clones();
        write(&a, "note.md", "# 제목\n\n공통 본문\n");
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        write(&a, "note.md", "# 제목 (A)\n\n공통 본문\n");
        ws(&a).sync("a").unwrap();
        write(&b, "note.md", "# 제목\n\n공통 본문\n\nB 추가 문단\n");
        assert!(git_raw(&b, &["add", "-A"]));
        assert!(git_raw(&b, &["commit", "-m", "B"]));
        assert!(git_raw(&b, &["fetch", "origin"]));
        assert!(git_raw(
            &b,
            &["merge", "--no-commit", "--no-ff", "origin/main"]
        ));
        assert!(b.join(".git/MERGE_HEAD").exists(), "잔재 MERGE_HEAD가 없다");

        // 병합이 만진 파일에 대한 unstaged 편집 → merge --abort가 거부하는 상황
        write(
            &b,
            "note.md",
            "# 제목 (A)\n\n공통 본문\n\nB 추가 문단\n\nDIRTY-EDIT\n",
        );

        let st = ws(&b).sync("recover").unwrap();
        assert_eq!(st.state, SyncState::Synced);
        assert!(
            !b.join(".git/MERGE_HEAD").exists(),
            "MERGE_HEAD 잔재가 남음"
        );
        let merged = read(&b, "note.md");
        assert!(
            merged.contains("DIRTY-EDIT"),
            "unstaged 편집 유실: {merged}"
        );
        // 치유 커밋(편집을 최초로 담은 커밋)은 낡은 병합을 완결한 두 부모
        // 커밋이 아니라 일반 단일 부모 커밋이어야 한다
        let hits = ws(&b)
            .run_ok(&["log", "--format=%H", "-S", "DIRTY-EDIT"])
            .unwrap();
        let healing = hits
            .split_whitespace()
            .last()
            .expect("편집이 어떤 커밋에도 없다")
            .to_string();
        let parents = ws(&b)
            .run_ok(&["log", "--format=%P", "-n", "1", &healing])
            .unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            1,
            "치유 커밋이 병합 커밋이다 (부모: {parents})"
        );
    }

    #[test]
    fn binary_conflict_keeps_both() {
        // 양쪽이 같은 .png를 다르게 변경 → theirs가 파일에, ours는 conflict 사본으로
        let (_tmp, a, b) = setup_two_clones();
        let base_png = vec![0x89u8, b'P', b'N', b'G', 0x00, 0xFF, 0xFE, 0x01];
        write_bytes(&a, "img.png", &base_png);
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        let a_png = vec![0x89u8, b'P', b'N', b'G', 0x00, 0xFF, 0xAA, 0xAA];
        let b_png = vec![0x89u8, b'P', b'N', b'G', 0x00, 0xFF, 0xBB, 0xBB];
        write_bytes(&a, "img.png", &a_png);
        ws(&a).sync("a").unwrap();
        write_bytes(&b, "img.png", &b_png);
        let st = ws(&b).sync("b").unwrap();

        assert_eq!(st.state, SyncState::Synced);
        // theirs(A)가 원래 이름, ours(B)는 conflict 사본
        assert_eq!(read_bytes(&b, "img.png"), a_png);
        assert_eq!(read_bytes(&b, "img (conflict).png"), b_png);
    }

    #[test]
    fn dot_synapse_conflict_resolved_by_deletion() {
        // .synapse/ 밑(레거시, draw/ 제외) 충돌은 삭제로 해결한다 (마이그레이션 과도기)
        let (_tmp, a, b) = setup_two_clones();
        write(&a, ".synapse/doc.txt", "공용 상태\n");
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        write(&a, ".synapse/doc.txt", "A가 바꾼 상태\n");
        ws(&a).sync("a").unwrap();
        write(&b, ".synapse/doc.txt", "B가 바꾼 상태\n");
        let st = ws(&b).sync("b").unwrap();

        assert_eq!(st.state, SyncState::Synced);
        // .synapse/ 충돌은 삭제로 해소되어 파일이 사라진다
        assert!(!b.join(".synapse/doc.txt").exists());
        assert_eq!(ws(&b).status().state, SyncState::Synced);
    }

    #[test]
    fn draw_sidecar_conflict_keeps_both() {
        // `.synapse/draw/`는 살아 있는 PDF 주석 데이터(pdf-draw 사이드카) —
        // 삭제 규칙의 예외로, 충돌 시 양쪽을 보존해야 한다
        // (원본=theirs, ours는 conflict 사본, 아무것도 삭제되지 않는다).
        let (_tmp, a, b) = setup_two_clones();
        let sidecar = ".synapse/draw/doc.pdf.draw.json";
        write(&a, sidecar, r#"{"strokes":[]}"#);
        ws(&a).sync("init").unwrap();
        ws(&b).sync("pull").unwrap();

        write(&a, sidecar, r#"{"strokes":["A"]}"#);
        ws(&a).sync("a").unwrap();
        write(&b, sidecar, r#"{"strokes":["B"]}"#);
        let st = ws(&b).sync("b").unwrap();

        assert_eq!(st.state, SyncState::Synced);
        // 원본은 theirs(A) 그대로 — 삭제되지 않았다
        assert!(b.join(sidecar).exists(), "주석 사이드카가 삭제됨");
        assert_eq!(read(&b, sidecar), r#"{"strokes":["A"]}"#);
        // ours(B)는 conflict 사본으로 보존 — 양쪽 모두 유효한 JSON
        assert_eq!(
            read(&b, ".synapse/draw/doc.pdf.draw (conflict).json"),
            r#"{"strokes":["B"]}"#
        );
        assert_eq!(ws(&b).status().state, SyncState::Synced);
    }

    // ----------------------------------------------------------------
    // 타임아웃·프롬프트 차단 (동기화 중 앱 멈춤 방지)
    // ----------------------------------------------------------------

    #[test]
    fn run_command_kills_process_on_timeout() {
        let cmd = slow_command();
        let started = Instant::now();
        let err = run_command(cmd, Some(Duration::from_millis(200))).unwrap_err();
        assert!(err.contains("초 안에 끝나지 않아"), "예상 밖 에러: {err}");
        assert!(started.elapsed() < Duration::from_secs(5), "kill이 지연됨");
    }

    #[test]
    fn run_command_passes_output_within_timeout() {
        let cmd = echo_command("hello");
        let (ok, stdout, _) = run_command(cmd, Some(Duration::from_secs(10))).unwrap();
        assert!(ok);
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "hello");
    }

    #[test]
    fn network_commands_get_timeout_local_commands_do_not() {
        assert!(network_timeout_for(&["fetch", "origin"]).is_some());
        assert!(network_timeout_for(&["push", "-u", "origin", "main"]).is_some());
        assert!(network_timeout_for(&["clone", "url", "dest"]).is_some());
        assert!(network_timeout_for(&["status", "--porcelain"]).is_none());
        assert!(network_timeout_for(&["rebase", "origin/main"]).is_none());
    }

    #[test]
    fn git_commands_block_credential_prompts() {
        let tmp = tempfile::tempdir().unwrap();
        let git = GitWorkspace::new(tmp.path(), None);
        let cmd = git.base_cmd();
        let envs: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().into_owned(),
                    v?.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        assert!(envs.contains(&("GIT_TERMINAL_PROMPT".into(), "0".into())));
        assert!(envs.contains(&("GCM_INTERACTIVE".into(), "never".into())));
        assert!(cmd
            .get_envs()
            .any(|(k, v)| k.to_string_lossy() == "GIT_ASKPASS" && v.is_none()));
    }

    #[cfg(windows)]
    fn slow_command() -> Command {
        let mut cmd = Command::new("ping");
        cmd.args(["-n", "10", "127.0.0.1"]);
        cmd
    }

    #[cfg(not(windows))]
    fn slow_command() -> Command {
        let mut cmd = Command::new("sleep");
        cmd.arg("10");
        cmd
    }

    #[cfg(windows)]
    fn echo_command(text: &str) -> Command {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "echo", text]);
        cmd
    }

    #[cfg(not(windows))]
    fn echo_command(text: &str) -> Command {
        let mut cmd = Command::new("printf");
        cmd.arg(text);
        cmd
    }

    // ----------------------------------------------------------------
    // 네트워크 구간에서 워크스페이스 락 해제 (동기화 중 저장 가능)
    // ----------------------------------------------------------------

    #[test]
    fn lock_is_free_during_fetch_and_saves_made_then_still_sync() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "a.md", "기준");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let mut git_b = GitWorkspace::new(&ws_b, None);

        // B를 behind 상태로 만들어 rebase 경로를 태운다
        write(&ws_a, "a.md", "A의 수정");
        git_a.sync("A").unwrap();
        write(&ws_b, "b.md", "B의 새 노트");

        // 다른 테스트와 간섭하지 않도록 이 워크스페이스 전용 락을 쓴다
        let lock: &'static Mutex<()> = Box::leak(Box::new(Mutex::new(())));
        git_b.lock = lock;
        let fired = Arc::new(AtomicBool::new(false));
        let fired_in_hook = Arc::clone(&fired);
        let ws_b_in_hook = ws_b.clone();
        git_b.after_fetch = Some(Box::new(move || {
            // 네트워크 구간에서는 락이 풀려 있어 저장이 진행될 수 있어야 한다
            assert!(lock.try_lock().is_ok(), "fetch 동안 락이 잡혀 있음");
            // fetch 동안 들어온 저장을 모사 — 이후 rebase가 깨지면 안 된다
            fs::write(ws_b_in_hook.join("during-fetch.md"), "동기화 중 저장").unwrap();
            fired_in_hook.store(true, Ordering::SeqCst);
        }));

        let status = git_b.sync("B").unwrap();
        assert!(
            fired.load(Ordering::SeqCst),
            "after_fetch 훅이 호출되지 않음"
        );
        assert_eq!(status.state, SyncState::Synced);
        // fetch 동안 저장된 파일까지 커밋·push 되어 깨끗해야 한다
        assert_eq!(git_b.status().state, SyncState::Synced);

        git_a.sync("A pull").unwrap();
        assert_eq!(read(&ws_a, "during-fetch.md"), "동기화 중 저장");
    }

    #[test]
    fn conflict_copy_naming() {
        assert_eq!(conflict_copy_name("a/b/note.md"), "a/b/note (conflict).md");
        assert_eq!(conflict_copy_name("README"), "README (conflict)");
    }

    // ----------------------------------------------------------------
    // 파일 히스토리 (FR-4.7)
    // ----------------------------------------------------------------

    /// 로컬 커밋만 있는 워크스페이스 git 레포를 만든다 (원격 없음)
    fn init_local_repo(ws: &Path) {
        let run = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(ws)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?} 실패");
        };
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Tester"]);
        run(&["config", "user.email", "tester@example.com"]);
    }

    fn commit_all(ws: &Path, message: &str) {
        let add = Command::new("git")
            .current_dir(ws)
            .args(["add", "-A"])
            .output()
            .unwrap();
        assert!(add.status.success());
        let commit = Command::new("git")
            .current_dir(ws)
            .args(["commit", "-m", message])
            .output()
            .unwrap();
        assert!(commit.status.success(), "commit 실패: {message}");
    }

    #[test]
    fn parse_file_history_splits_records_and_fields() {
        let raw = "h1\u{1f}s1\u{1f}Alice\u{1f}2026-06-11T10:00:00+09:00\u{1f}첫 커밋\u{1e}\n\
                   h2\u{1f}s2\u{1f}Bob\u{1f}2026-06-11T11:00:00+09:00\u{1f}둘째 커밋\u{1e}\n";
        let commits = parse_file_history(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "h1");
        assert_eq!(commits[0].short_hash, "s1");
        assert_eq!(commits[0].author, "Alice");
        assert_eq!(commits[0].timestamp, "2026-06-11T10:00:00+09:00");
        assert_eq!(commits[0].message, "첫 커밋");
        assert_eq!(commits[1].author, "Bob");
        assert_eq!(commits[1].message, "둘째 커밋");
        // 빈 출력은 빈 목록
        assert!(parse_file_history("").is_empty());
        assert!(parse_file_history("\n").is_empty());
    }

    #[test]
    fn file_history_lists_commits_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        init_local_repo(ws);

        write(ws, "note.md", "v1");
        commit_all(ws, "첫 버전");
        write(ws, "note.md", "v2");
        commit_all(ws, "둘째 버전");
        write(ws, "note.md", "v3");
        commit_all(ws, "셋째 버전");

        let git = GitWorkspace::new(ws, None);
        let history = git.file_history("note.md").unwrap();
        assert_eq!(history.len(), 3);
        // 최신순
        assert_eq!(history[0].message, "셋째 버전");
        assert_eq!(history[1].message, "둘째 버전");
        assert_eq!(history[2].message, "첫 버전");
        // 해시·시각이 채워져 있다
        assert!(!history[0].hash.is_empty());
        assert!(!history[0].short_hash.is_empty());
        assert!(history[0].timestamp.contains('T'));
        assert_eq!(history[0].author, "Tester");
    }

    #[test]
    fn file_at_revision_returns_old_content() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        init_local_repo(ws);

        write(ws, "note.md", "원래 내용\n");
        commit_all(ws, "v1");
        write(ws, "note.md", "수정된 내용\n");
        commit_all(ws, "v2");

        let git = GitWorkspace::new(ws, None);
        let history = git.file_history("note.md").unwrap();
        assert_eq!(history.len(), 2);

        // 가장 오래된 커밋(v1)의 내용을 복원
        let old = git.file_at_revision("note.md", &history[1].hash).unwrap();
        assert_eq!(old, "원래 내용\n");
        // 최신 커밋은 현재 내용
        let new = git.file_at_revision("note.md", &history[0].hash).unwrap();
        assert_eq!(new, "수정된 내용\n");
    }

    #[test]
    fn file_at_revision_errors_for_missing_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        init_local_repo(ws);
        write(ws, "note.md", "x");
        commit_all(ws, "v1");

        let git = GitWorkspace::new(ws, None);
        let head = git.file_history("note.md").unwrap()[0].hash.clone();
        // 존재하지 않는 파일은 에러 (앱이 죽지 않고 우아하게 보고)
        assert!(git.file_at_revision("nope.md", &head).is_err());
    }

    #[test]
    fn file_history_empty_for_untracked_and_non_repo() {
        // git 레포지만 추적되지 않는 파일
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        init_local_repo(ws);
        write(ws, "tracked.md", "x");
        commit_all(ws, "v1");
        write(ws, "untracked.md", "y"); // 커밋 안 함
        let git = GitWorkspace::new(ws, None);
        assert!(git.file_history("untracked.md").unwrap().is_empty());

        // git 레포가 아닌 폴더
        let plain = tempfile::tempdir().unwrap();
        write(plain.path(), "note.md", "x");
        let git2 = GitWorkspace::new(plain.path(), None);
        assert!(git2.file_history("note.md").unwrap().is_empty());
    }
}
