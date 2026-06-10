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
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

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
        SyncStatus { state, ahead: 0, behind: 0, conflict_files: vec![], message: None }
    }
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
    /// "AUTHORIZATION: basic …" 형태의 추가 헤더 (GitHub HTTPS 인증)
    auth_header: Option<String>,
}

type GitResult<T> = Result<T, String>;

impl GitWorkspace {
    pub fn new(root: impl Into<PathBuf>, auth_header: Option<String>) -> Self {
        GitWorkspace { root: root.into(), auth_header }
    }

    /// GitHub 토큰으로 HTTPS 인증 헤더를 만든다 (actions/checkout과 같은 방식).
    pub fn auth_header_for_token(token: &str) -> String {
        format!("AUTHORIZATION: basic {}", base64(format!("x-access-token:{token}").as_bytes()))
    }

    fn run(&self, args: &[&str]) -> GitResult<(bool, String, String)> {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root);
        // 인증 헤더는 원격 통신 명령에만 의미가 있지만 항상 끼워도 무해하다
        if let Some(header) = &self.auth_header {
            cmd.args(["-c", &format!("http.https://github.com/.extraheader={header}")]);
        }
        cmd.args(args);
        let out = cmd
            .output()
            .map_err(|e| format!("git 실행 실패 (git이 설치되어 있나요?): {e}"))?;
        Ok((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    fn run_ok(&self, args: &[&str]) -> GitResult<String> {
        let (ok, stdout, stderr) = self.run(args)?;
        if ok {
            Ok(stdout)
        } else {
            Err(format!("git {} 실패: {}", args.first().unwrap_or(&""), stderr.trim()))
        }
    }

    pub fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
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
        Ok(self.run_ok(&["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string())
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
        let (ok, out, _) =
            self.run(&["rev-list", "--left-right", "--count", &format!("HEAD...{upstream}")])?;
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
        if !Self::git_available() {
            return Ok(SyncStatus::simple(SyncState::NoGit));
        }
        if !self.is_repo() {
            return Ok(SyncStatus::simple(SyncState::NoRepo));
        }
        if !self.has_remote() {
            return Ok(SyncStatus::simple(SyncState::NoRemote));
        }
        self.commit_all(commit_message)?;
        self.run_ok(&["fetch", "origin"])?;

        let upstream = self.upstream()?;
        let (upstream_exists, _, _) =
            self.run(&["rev-parse", "--verify", &format!("{upstream}^{{commit}}")])?;
        if upstream_exists {
            let (_, behind) = self.ahead_behind()?;
            if behind > 0 {
                let (ok, _, _) = self.run(&["rebase", &upstream])?;
                if !ok {
                    let files = self.conflicted_files()?;
                    self.run_ok(&["rebase", "--abort"])?;
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
        let branch = self.current_branch()?;
        self.run_ok(&["push", "-u", "origin", &branch])?;
        Ok(SyncStatus::simple(SyncState::Synced))
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
        self.commit_all("synapse: 충돌 해결 전 저장")?;
        self.run_ok(&["fetch", "origin"])?;
        let upstream = self.upstream()?;

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
                    fs::write(self.root.join(&conflict_name), content)
                        .map_err(|e| e.to_string())?;
                }
                self.commit_all("synapse: 충돌한 내 버전을 (conflict) 사본으로 보존")?;
            }
        }
        let branch = self.current_branch()?;
        self.run_ok(&["push", "-u", "origin", &branch])?;
        Ok(SyncStatus::simple(SyncState::Synced))
    }
}

/// "dir/note.md" → "dir/note (conflict).md"
fn conflict_copy_name(path: &str) -> String {
    match path.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (conflict).{ext}"),
        _ => format!("{path} (conflict)"),
    }
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bare 원격 + 워크스페이스 하나를 만든다
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let out = Command::new("git")
            .args(["init", "--bare", "-b", "main", &remote.display().to_string()])
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

    #[test]
    fn publish_then_status_synced() {
        let (_tmp, remote, ws) = setup();
        write(&ws, "note.md", "# 첫 노트");
        let git = GitWorkspace::new(&ws, None);
        assert_eq!(git.status().state, SyncState::NoRepo);

        let status = git.publish(&remote.display().to_string(), "synapse: 초기 게시").unwrap();
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
        assert_eq!(git.sync("synapse: update").unwrap().state, SyncState::Synced);
        assert_eq!(git.status().state, SyncState::Synced);
    }

    #[test]
    fn changes_propagate_between_two_clones() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "A의 첫 내용");
        git_a.publish(&remote.display().to_string(), "init").unwrap();

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
        git_a.publish(&remote.display().to_string(), "init").unwrap();

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
    fn resolve_keep_mine_wins_on_remote() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "기준");
        git_a.publish(&remote.display().to_string(), "init").unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);

        write(&ws_a, "shared.md", "A의 수정");
        git_a.sync("A").unwrap();
        write(&ws_b, "shared.md", "B의 수정");
        assert_eq!(git_b.sync("B").unwrap().state, SyncState::Conflict);

        assert_eq!(git_b.resolve_conflicts(ConflictChoice::KeepMine).unwrap().state, SyncState::Synced);
        git_a.sync("A pull").unwrap();
        assert_eq!(read(&ws_a, "shared.md"), "B의 수정");
    }

    #[test]
    fn resolve_keep_remote_discards_mine() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        write(&ws_a, "shared.md", "기준");
        git_a.publish(&remote.display().to_string(), "init").unwrap();

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
        git_a.publish(&remote.display().to_string(), "init").unwrap();

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

    #[test]
    fn conflict_copy_naming() {
        assert_eq!(conflict_copy_name("a/b/note.md"), "a/b/note (conflict).md");
        assert_eq!(conflict_copy_name("README"), "README (conflict)");
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"x-access-token:abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
    }
}
