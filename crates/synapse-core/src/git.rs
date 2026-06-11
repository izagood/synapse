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

use crate::collab::{self, CollabStore};

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
        let (ok, stdout, stderr) = self.run_bytes(args)?;
        Ok((ok, String::from_utf8_lossy(&stdout).into_owned(), stderr))
    }

    /// stdout을 바이트 그대로 돌려주는 변형 (`git show :N:경로`로 바이너리
    /// 스테이지 내용을 읽을 때 손상되지 않도록)
    fn run_bytes(&self, args: &[&str]) -> GitResult<(bool, Vec<u8>, String)> {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root);
        // rebase --continue 등이 에디터를 띄우지 않게 한다
        cmd.env("GIT_EDITOR", "true");
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
            out.stdout,
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
        if let Some(store) = collab {
            self.absorb_workspace(store);
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
        let branch = self.current_branch()?;
        self.run_ok(&["push", "-u", "origin", &branch])?;
        Ok(SyncStatus::simple(SyncState::Synced))
    }

    /// 워크스페이스의 모든 .md를 훑어 CRDT와 어긋난 외부 편집(GitHub 웹,
    /// 다른 에디터 등)을 결정적으로 흡수한다. 개별 파일 실패는 무시한다.
    fn absorb_workspace(&self, store: &CollabStore) {
        fn walk(dir: &Path, store: &CollabStore) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue; // .git, .synapse 등
                }
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, store);
                } else if name.ends_with(".md") {
                    if let Ok(text) = fs::read_to_string(&path) {
                        if let Some(id) = collab::extract_doc_id(&text) {
                            let _ = store.absorb_external(&id, &text);
                        }
                    }
                }
            }
        }
        walk(&self.root, store);
    }

    fn rebase_in_progress(&self) -> GitResult<bool> {
        let merge = self.run_ok(&["rev-parse", "--git-path", "rebase-merge"])?;
        let apply = self.run_ok(&["rev-parse", "--git-path", "rebase-apply"])?;
        Ok(self.root.join(merge.trim()).exists() || self.root.join(apply.trim()).exists())
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
                        let _ = fs::create_dir_all(parent);
                    }
                    fs::write(&abs, bytes).map_err(|e| e.to_string())?;
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
            (Some(a), Some(b)) => if a <= b { a.clone() } else { b.clone() },
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
                        let (other, side_md) =
                            if *a == target { (b, &side3) } else { (a, &side2) };
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
        fs::write(self.root.join(path), &merged).map_err(|e| e.to_string())?;
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
        let store_a = CollabStore::new(&ws_a, "actor-aaaa-1111".to_string());

        let base = doc_text("# 회의록\n\n- 안건 하나\n");
        save_via_store(&store_a, &ws_a, "note.md", "", &base);
        git_a.publish(&remote.display().to_string(), "init").unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);
        let store_b = CollabStore::new(&ws_b, "actor-bbbb-2222".to_string());

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
            git_a.sync_with_collab("A pull", Some(&store_a)).unwrap().state,
            SyncState::Synced
        );

        let merged_b = read(&ws_b, "note.md");
        assert!(merged_b.contains("(A 제목 수정)"), "A의 편집 유실: {merged_b}");
        assert!(merged_b.contains("B가 추가한 안건"), "B의 편집 유실: {merged_b}");
        assert_eq!(read(&ws_a, "note.md"), merged_b);
        // 양쪽 CRDT도 같은 텍스트로 수렴
        assert_eq!(store_a.doc_text(DOC_ID).unwrap(), merged_b);
        assert_eq!(store_b.doc_text(DOC_ID).unwrap(), merged_b);
    }

    #[test]
    fn non_md_conflict_still_reports_conflict() {
        let (tmp, remote, ws_a) = setup();
        let git_a = GitWorkspace::new(&ws_a, None);
        let store_a = CollabStore::new(&ws_a, "actor-aaaa-1111".to_string());
        write(&ws_a, "data.txt", "기준");
        git_a.publish(&remote.display().to_string(), "init").unwrap();

        let ws_b = tmp.path().join("clone-b");
        GitWorkspace::clone(&remote.display().to_string(), &ws_b, None).unwrap();
        let git_b = GitWorkspace::new(&ws_b, None);
        let store_b = CollabStore::new(&ws_b, "actor-bbbb-2222".to_string());

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
        let store = CollabStore::new(&ws, "actor-aaaa-1111".to_string());

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
