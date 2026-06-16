//! GitHub 동기화 엔진 (FR-4).
//!
//! 시스템 `git` CLI를 서브프로세스로 구동한다. libgit2 대비 선택 이유:
//! 충돌·rebase 동작이 사용자의 git과 100% 동일하고, 실제 리포지토리로
//! 통합 테스트가 가능하다. git 미설치 환경은 `SyncState::NoGit`으로 안내한다.
//!
//! 상태 머신: idle → dirty → committing → pulling/pushing → synced | conflict
//! 충돌은 항상 rebase --abort 후 호출자에게 보고하므로 리포지토리가
//! 충돌 상태로 방치되지 않는다 — 해결은 `resolve_conflicts`의 3택으로 수행한다.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::collab::{self, CollabStore};
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

impl GitWorkspace {
    pub fn new(root: impl Into<PathBuf>, auth_header: Option<String>) -> Self {
        GitWorkspace {
            root: root.into(),
            auth_header,
            exec: GitExec::Local,
            backend: Arc::new(LocalBackend),
            lock: collab::workspace_lock(),
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
            lock: collab::workspace_lock(),
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

    /// commit → fetch → rebase → push 한 사이클 (FR-4.3/4.4)
    pub fn sync(&self, commit_message: &str) -> GitResult<SyncStatus> {
        self.sync_with_collab(commit_message, None)
    }

    /// `sync`에 CRDT 협업 계층을 끼운 버전 (FR-6).
    ///
    /// - 시작 시 워크스페이스의 외부 편집(.md가 CRDT와 어긋난 것)을 흡수해
    ///   같은 커밋에 로그가 함께 실리게 한다.
    /// - rebase 충돌이 나면 CRDT로 자동 해결을 시도하고, 실패한 경우에만
    ///   기존처럼 abort 후 Conflict를 보고한다(3택 UI 폴백).
    pub fn sync_with_collab(
        &self,
        commit_message: &str,
        collab: Option<&CollabStore>,
    ) -> GitResult<SyncStatus> {
        if !Self::git_available() {
            return Ok(SyncStatus::simple(SyncState::NoGit));
        }
        if !self.is_repo() {
            return Ok(SyncStatus::simple(SyncState::NoRepo));
        }
        if !self.has_remote() {
            return Ok(SyncStatus::simple(SyncState::NoRemote));
        }
        // 로컬 구간 1 (락): 외부 편집 흡수 + 커밋
        {
            let _guard = self.lock_local()?;
            if let Some(store) = collab {
                self.absorb_workspace(store);
            }
            self.commit_all(commit_message)?;
        }

        // 네트워크 구간 (락 없음): fetch 동안 저장이 막히지 않는다
        self.run_ok(&["fetch", "origin"])?;
        #[cfg(test)]
        if let Some(hook) = &self.after_fetch {
            hook();
        }

        // 로컬 구간 2 (락): rebase + CRDT 자동 해결
        {
            let _guard = self.lock_local()?;
            // fetch 동안 들어온 저장을 먼저 커밋해 rebase에 깨끗한 트리를 보장
            self.commit_all(commit_message)?;
            let upstream = self.upstream()?;
            let (upstream_exists, _, _) =
                self.run(&["rev-parse", "--verify", &format!("{upstream}^{{commit}}")])?;
            if upstream_exists {
                let (_, behind) = self.ahead_behind()?;
                if behind > 0 {
                    let (ok, _, _) = self.run(&["rebase", &upstream])?;
                    if !ok {
                        let resolved =
                            collab.is_some_and(|store| self.auto_resolve_rebase(store).is_ok());
                        if !resolved {
                            let files = self.conflicted_files()?;
                            let _ = self.run(&["rebase", "--abort"]);
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
        }

        // 네트워크 구간 (락 없음): push는 워킹트리를 만지지 않는다
        let branch = self.current_branch()?;
        self.run_ok(&["push", "-u", "origin", &branch])?;
        Ok(SyncStatus::simple(SyncState::Synced))
    }

    /// 워크스페이스의 모든 .md를 훑어 CRDT와 어긋난 외부 편집(GitHub 웹,
    /// 다른 에디터 등)을 결정적으로 흡수한다. 개별 파일 실패는 무시한다.
    fn absorb_workspace(&self, store: &CollabStore) {
        // 백엔드 트리(숨김·심볼릭 링크 제외 — .synapse도 제외됨)를 훑어 .md만 흡수.
        // build_tree가 로컬/원격(SFTP) 공통 순회 정책을 제공한다.
        let Ok(tree) = self.backend.build_tree(&self.root) else {
            return;
        };
        let mut stack = vec![tree];
        while let Some(node) = stack.pop() {
            match node.children {
                Some(children) => stack.extend(children),
                None => {
                    if node.name.ends_with(".md") {
                        if let Ok(text) = self.backend.read_to_string(Path::new(&node.path)) {
                            if let Some(id) = collab::extract_doc_id(&text) {
                                let _ = store.absorb_external(&id, &text);
                            }
                        }
                    }
                }
            }
        }
    }

    fn rebase_in_progress(&self) -> GitResult<bool> {
        let merge = self.run_ok(&["rev-parse", "--git-path", "rebase-merge"])?;
        let apply = self.run_ok(&["rev-parse", "--git-path", "rebase-apply"])?;
        Ok(self.backend.exists(&self.root.join(merge.trim()))
            || self.backend.exists(&self.root.join(apply.trim())))
    }

    /// 충돌 스테이지(:1: base, :2: ours, :3: theirs)의 내용. 해당 스테이지가
    /// 없으면(삭제 등) None.
    fn stage_bytes(&self, stage: u8, path: &str) -> GitResult<Option<Vec<u8>>> {
        let spec = format!(":{stage}:{path}");
        let (ok, out, _) = self.run_bytes(&["show", &spec])?;
        Ok(ok.then_some(out))
    }

    fn stage_text(&self, stage: u8, path: &str) -> GitResult<Option<String>> {
        Ok(self
            .stage_bytes(stage, path)?
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    /// 중단된 rebase의 충돌을 CRDT로 해결하며 끝까지 진행한다.
    /// 실패 시 rebase는 중단된 채로 남으며 호출자가 abort 한다.
    fn auto_resolve_rebase(&self, store: &CollabStore) -> GitResult<()> {
        for _ in 0..256 {
            if !self.rebase_in_progress()? {
                return Ok(());
            }
            let mut files = self.conflicted_files()?;
            // .synapse 로그를 먼저 합쳐야 .md 해석 시 CRDT가 양쪽 편집을 모두 본다
            files.sort_by_key(|f| !f.starts_with(collab::DATA_DIR));
            for file in &files {
                self.resolve_one(store, file)?;
            }
            let (ok, out, err) = self.run(&["rebase", "--continue"])?;
            if !ok {
                if !self.conflicted_files()?.is_empty() {
                    continue; // 다음 커밋의 충돌 — 루프가 이어서 처리
                }
                let combined = format!("{out}\n{err}");
                if combined.contains("--skip") || combined.contains("No changes") {
                    // 해결 결과가 업스트림과 동일해 빈 커밋이 된 경우
                    let _ = self.run(&["rebase", "--skip"]);
                } else {
                    return Err(format!("rebase --continue 실패: {}", err.trim()));
                }
            }
        }
        Err("rebase 자동 해결이 수렴하지 않습니다".to_string())
    }

    /// 충돌 파일 하나를 CRDT 규칙으로 해결하고 스테이징한다.
    /// 자동 해결 대상이 아니면 Err — 전체가 3택 UI로 폴백된다.
    fn resolve_one(&self, store: &CollabStore, path: &str) -> GitResult<()> {
        let name = path.rsplit('/').next().unwrap_or(path);

        if path.starts_with(&format!("{}/", collab::DATA_DIR)) {
            let ours = self.stage_bytes(2, path)?;
            let theirs = self.stage_bytes(3, path)?;
            let resolved = if name.starts_with("log-") && name.ends_with(".y") {
                // 로그는 append-only 업데이트 프레임 — 합집합이 항상 안전하다
                Some(collab::merge_log_bytes(
                    ours.as_deref().unwrap_or(&[]),
                    theirs.as_deref().unwrap_or(&[]),
                ))
            } else {
                // 스냅샷은 내용 해시 이름의 불변 파일 — 존재하는 쪽을 살린다
                // (삭제/수정 충돌이면 보존이 안전: 여분 스냅샷은 무해하다)
                ours.or(theirs)
            };
            match resolved {
                Some(bytes) => {
                    let abs = self.root.join(path);
                    if let Some(parent) = abs.parent() {
                        let _ = self.backend.create_dir_all(parent);
                    }
                    self.backend
                        .write(&abs, &bytes)
                        .map_err(|e| e.to_string())?;
                    self.run_ok(&["add", "--", path])?;
                }
                None => {
                    self.run_ok(&["rm", "-f", "--", path])?;
                }
            }
            return Ok(());
        }

        if !name.ends_with(".md") {
            return Err(format!("CRDT 자동 해결 대상이 아닌 파일: {path}"));
        }
        let base = self.stage_text(1, path)?.unwrap_or_default();
        let (Some(side2), Some(side3)) = (self.stage_text(2, path)?, self.stage_text(3, path)?)
        else {
            return Err(format!("삭제/수정 충돌은 자동 해결하지 않습니다: {path}"));
        };
        let id2 = collab::extract_doc_id(&side2);
        let id3 = collab::extract_doc_id(&side3);
        // 두 클라이언트가 같은 파일에 서로 다른 id를 동시에 발급했다면
        // 사전순으로 작은 id를 채택한다 (양쪽 모두 같은 결론에 도달)
        let target = match (&id2, &id3) {
            (Some(a), Some(b)) => {
                if a <= b {
                    a.clone()
                } else {
                    b.clone()
                }
            }
            (Some(a), None) => a.clone(),
            (None, Some(b)) => b.clone(),
            (None, None) => return Err(format!("synapse_id가 없어 자동 해결 불가: {path}")),
        };
        // id 줄 차이가 본문 diff에 끼지 않도록 모두 target id로 정규화
        let norm = |t: &str| -> String {
            if collab::extract_doc_id(t).is_some() {
                collab::inject_doc_id(t, &target)
            } else {
                t.to_string()
            }
        };
        let base_n = norm(&base);

        let mut merged = match store.doc_text(&target) {
            // CRDT 데이터가 있으면 그 텍스트가 곧 머지 결과다 — actor별
            // 로그는 트리 머지(또는 위의 합집합)로 이미 양쪽 편집을 담고 있다
            Some(text) => {
                let mut m = text;
                if let (Some(a), Some(b)) = (&id2, &id3) {
                    if a != b {
                        // 다른 id 밑에 저장된 쪽의 편집을 target 문서로 흡수한다
                        let (other, side_md) = if *a == target {
                            (b, &side3)
                        } else {
                            (a, &side2)
                        };
                        let side = store
                            .doc_text(other)
                            .map(|t| collab::inject_doc_id(&t, &target))
                            .unwrap_or_else(|| norm(side_md));
                        m = store
                            .absorb_three_way(&target, &base_n, &side)
                            .map_err(|e| e.to_string())?;
                    }
                }
                m
            }
            // 협업 데이터가 없는 레거시 충돌: base 기준으로 양쪽을 차례로
            // 결정적 3-way 머지한다 (어느 클라이언트가 해도 같은 결과)
            None => {
                store
                    .absorb_three_way(&target, &base_n, &norm(&side2))
                    .map_err(|e| e.to_string())?;
                store
                    .absorb_three_way(&target, &base_n, &norm(&side3))
                    .map_err(|e| e.to_string())?
            }
        };
        if collab::extract_doc_id(&merged).as_deref() != Some(target.as_str()) {
            merged = collab::inject_doc_id(&merged, &target);
            let _ = store.absorb_external(&target, &merged);
        }
        self.backend
            .write(&self.root.join(path), merged.as_bytes())
            .map_err(|e| e.to_string())?;
        self.run_ok(&["add", "--", path])?;
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
            .filter(|f| !f.starts_with(collab::DATA_DIR))
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

    fn write(dir: &Path, name: &str, content: &str) {
        fs::write(dir.join(name), content).unwrap();
    }

    fn read(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).unwrap()
    }

    fn normalize_newlines(text: &str) -> String {
        text.replace("\r\n", "\n")
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
        write(&ws_b, "shared.md", "B의 수정");
        let status = git_b.sync("B").unwrap();

        assert_eq!(status.state, SyncState::Conflict);
        assert_eq!(status.conflict_files, vec!["shared.md"]);
        // rebase --abort 되어 충돌 마커 없이 내 내용 그대로여야 한다
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
        write(&ws_b, "shared.md", "B의 수정");
        let status = git_b.sync("B").unwrap();
        assert_eq!(status.state, SyncState::Conflict);

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
        write(&ws_b, "shared.md", "B의 수정");
        assert_eq!(git_b.sync("B").unwrap().state, SyncState::Conflict);

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
        git_b.sync("B").unwrap();

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
        git_b.sync("B").unwrap();

        git_b.resolve_conflicts(ConflictChoice::KeepBoth).unwrap();
        assert_eq!(read(&ws_b, "shared.md"), "A의 수정");
        assert_eq!(read(&ws_b, "shared (conflict).md"), "B의 수정");

        // 사본까지 원격에 반영되어 A에서도 보인다
        git_a.sync("A pull").unwrap();
        assert_eq!(read(&ws_a, "shared (conflict).md"), "B의 수정");
    }

    // ----------------------------------------------------------------
    // CRDT 자동 충돌 해결 (FR-6)
    // ----------------------------------------------------------------

    const DOC_ID: &str = "11111111-1111-1111-1111-111111111111";

    fn doc_text(body: &str) -> String {
        format!("---\nsynapse_id: {DOC_ID}\n---\n\n{body}")
    }

    /// 에디터 저장 흐름을 모사: CRDT에 기록하고 .md를 그 결과로 쓴다
    fn save_via_store(store: &CollabStore, ws: &Path, file: &str, base: &str, new: &str) {
        let merged = store.save_text(DOC_ID, base, new).unwrap();
        fs::write(ws.join(file), merged).unwrap();
    }

    #[test]
    fn crdt_auto_resolves_concurrent_md_edits() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        let store_a = CollabStore::local(&ws_a, "actor-aaaa-1111".to_string());

        let base = doc_text("# 회의록\n\n- 안건 하나\n");
        save_via_store(&store_a, &ws_a, "note.md", "", &base);
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);
        let store_b = CollabStore::local(&ws_b, "actor-bbbb-2222".to_string());

        // A와 B가 같은 문서의 다른 부분을 동시에 편집
        let a_edit = base.replace("# 회의록", "# 회의록 (A 제목 수정)");
        save_via_store(&store_a, &ws_a, "note.md", &base, &a_edit);
        let b_edit = base.replace("- 안건 하나", "- 안건 하나\n- B가 추가한 안건");
        save_via_store(&store_b, &ws_b, "note.md", &base, &b_edit);

        assert_eq!(
            git_a.sync_with_collab("A", Some(&store_a)).unwrap().state,
            SyncState::Synced
        );
        // B는 note.md에서 git 충돌이 나지만 CRDT로 자동 해결되어야 한다
        assert_eq!(
            git_b.sync_with_collab("B", Some(&store_b)).unwrap().state,
            SyncState::Synced
        );
        assert_eq!(
            git_a
                .sync_with_collab("A pull", Some(&store_a))
                .unwrap()
                .state,
            SyncState::Synced
        );

        let merged_b = read(&ws_b, "note.md");
        assert!(
            merged_b.contains("(A 제목 수정)"),
            "A의 편집 유실: {merged_b}"
        );
        assert!(
            merged_b.contains("B가 추가한 안건"),
            "B의 편집 유실: {merged_b}"
        );
        assert_eq!(
            normalize_newlines(&read(&ws_a, "note.md")),
            normalize_newlines(&merged_b)
        );
        // 양쪽 CRDT도 같은 텍스트로 수렴
        assert_eq!(
            normalize_newlines(&store_a.doc_text(DOC_ID).unwrap()),
            normalize_newlines(&merged_b)
        );
        assert_eq!(
            normalize_newlines(&store_b.doc_text(DOC_ID).unwrap()),
            normalize_newlines(&merged_b)
        );
    }

    #[test]
    fn non_md_conflict_still_reports_conflict() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        let store_a = CollabStore::local(&ws_a, "actor-aaaa-1111".to_string());
        write(&ws_a, "data.txt", "기준");
        git_a
            .publish(&remote.display().to_string(), "init")
            .unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);
        let store_b = CollabStore::local(&ws_b, "actor-bbbb-2222".to_string());

        write(&ws_a, "data.txt", "A의 수정");
        git_a.sync_with_collab("A", Some(&store_a)).unwrap();
        write(&ws_b, "data.txt", "B의 수정");
        let status = git_b.sync_with_collab("B", Some(&store_b)).unwrap();

        assert_eq!(status.state, SyncState::Conflict);
        assert_eq!(status.conflict_files, vec!["data.txt"]);
        // rebase --abort 되어 워크스페이스는 깨끗해야 한다
        assert_eq!(read(&ws_b, "data.txt"), "B의 수정");
    }

    #[test]
    fn sync_absorbs_external_md_edits() {
        let (_tmp, remote, ws) = setup();
        let git = GitWorkspace::new(&ws, None);
        let store = CollabStore::local(&ws, "actor-aaaa-1111".to_string());

        let base = doc_text("원래 내용\n");
        save_via_store(&store, &ws, "note.md", "", &base);
        git.publish(&remote.display().to_string(), "init").unwrap();

        // CRDT를 거치지 않은 외부 편집 (GitHub 웹 편집을 모사)
        let external = doc_text("원래 내용\n\n외부에서 추가한 줄\n");
        fs::write(ws.join("note.md"), &external).unwrap();

        assert_eq!(
            git.sync_with_collab("sync", Some(&store)).unwrap().state,
            SyncState::Synced
        );
        // sync가 외부 편집을 CRDT로 흡수했어야 한다
        assert_eq!(store.doc_text(DOC_ID).unwrap(), external);
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
