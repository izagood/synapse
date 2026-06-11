//! 협업 CRDT 저장 계층 (FR-6: 충돌 제로 공동 편집).
//!
//! 문서의 진실은 yrs(Yjs Rust 포트) CRDT이고, `.md`는 사람이 읽는 스냅샷이다.
//! git에서 절대 충돌하지 않도록 두 가지 규칙을 지킨다:
//!
//! 1. **actor별 append-only 로그** — 각 설치본(actor)은
//!    `.synapse/docs/<id>/log-<actor>.y` 자기 파일에만 쓴다. 서로 다른
//!    파일만 만지므로 git 트리 머지는 구조적으로 항상 성공한다.
//! 2. **스냅샷은 내용 해시 이름의 불변 파일** — `snap-<hash>.y`는 한 번
//!    쓰이면 수정되지 않는다(수정 충돌 불가). 압축 시 자기 로그만 비우고,
//!    자신이 이미 읽어들인(=포함한) 옛 스냅샷만 지운다.
//!
//! CRDT 텍스트는 frontmatter를 포함한 `.md` 파일 전문이다. 문서 식별은
//! frontmatter의 `synapse_id`로 하므로 파일 이동/이름 변경에도 이력이 유지된다.
//!
//! 외부 편집(GitHub 웹 등)은 **결정적 absorb**로 수용한다: 같은 CRDT 상태에서
//! 같은 디스크 텍스트를 흡수하면 어느 클라이언트든 바이트 단위로 동일한
//! 업데이트를 만들므로(client id를 상태+내용 해시로 유도), 여러 클라이언트가
//! 같은 외부 편집을 동시에 흡수해도 중복 삽입이 생기지 않는다.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use yrs::updates::decoder::Decode;
use yrs::{
    ClientID, Doc, GetString, Options, ReadTxn, StateVector, Text, TextRef, Transact, Update,
};

/// 워크스페이스 안의 협업 데이터 디렉토리 이름
pub const DATA_DIR: &str = ".synapse";
const TEXT_ROOT: &str = "content";
const ID_KEY: &str = "synapse_id";
/// 자기 로그가 이 크기를 넘으면 스냅샷으로 압축한다
const COMPACT_THRESHOLD: u64 = 64 * 1024;

/// 같은 프로세스 안에서 save/absorb/sync가 한 워크스페이스의 CRDT를
/// 동시에 만지지 않도록 직렬화한다 (멀티 윈도우 대비).
pub fn workspace_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 설치본 단위 actor id를 읽거나 새로 만든다 (로그 파일 이름에 쓰인다)
pub fn load_or_create_actor_id(config_dir: &Path) -> io::Result<String> {
    let path = config_dir.join("actor-id");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if valid_id(&trimmed) {
            return Ok(trimmed);
        }
    }
    fs::create_dir_all(config_dir)?;
    let id = new_doc_id();
    crate::fs_io::atomic_write(&path, &id)?;
    Ok(id)
}

pub fn new_doc_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 파일 내용에서 온 id가 경로로 쓰이므로 엄격히 검증한다 (경로 탈출 방지)
pub fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

// ---------------------------------------------------------------------------
// frontmatter synapse_id
// ---------------------------------------------------------------------------

/// frontmatter 블록의 (본문 시작, 닫는 `---` 줄 시작) 바이트 오프셋
fn frontmatter_range(text: &str) -> Option<(usize, usize)> {
    let after_open = text
        .strip_prefix("---\r\n")
        .map(|_| 5)
        .or_else(|| text.strip_prefix("---\n").map(|_| 4))?;
    let mut pos = after_open;
    for line in text[after_open..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((after_open, pos));
        }
        pos += line.len();
    }
    None
}

/// frontmatter의 `synapse_id` 값을 읽는다 (검증 포함)
pub fn extract_doc_id(text: &str) -> Option<String> {
    let (start, end) = frontmatter_range(text)?;
    for line in text[start..end].lines() {
        if let Some(value) = line.strip_prefix(&format!("{ID_KEY}:")) {
            let id = value.trim().to_string();
            return valid_id(&id).then_some(id);
        }
    }
    None
}

/// `synapse_id`를 주입하거나 기존 값을 교체한 전문을 돌려준다
pub fn inject_doc_id(text: &str, id: &str) -> String {
    match frontmatter_range(text) {
        Some((start, end)) => {
            let mut block = String::new();
            let mut replaced = false;
            for line in text[start..end].split_inclusive('\n') {
                if line.trim_start().starts_with(&format!("{ID_KEY}:")) {
                    block.push_str(&format!("{ID_KEY}: {id}\n"));
                    replaced = true;
                } else {
                    block.push_str(line);
                }
            }
            if !replaced {
                if !block.is_empty() && !block.ends_with('\n') {
                    block.push('\n');
                }
                block.push_str(&format!("{ID_KEY}: {id}\n"));
            }
            format!("{}{}{}", &text[..start], block, &text[end..])
        }
        None => format!("---\n{ID_KEY}: {id}\n---\n\n{text}"),
    }
}

// ---------------------------------------------------------------------------
// 텍스트 diff → CRDT 연산
// ---------------------------------------------------------------------------

/// base 좌표계의 패치 (바이트 오프셋, 문자 경계 보장)
struct Patch {
    pos: usize,
    del: usize,
    ins: String,
}

fn diff_patches(base: &str, new: &str) -> Vec<Patch> {
    let mut pos = 0usize;
    let mut out = Vec::new();
    for chunk in dissimilar::diff(base, new) {
        match chunk {
            dissimilar::Chunk::Equal(s) => pos += s.len(),
            dissimilar::Chunk::Delete(s) => {
                out.push(Patch {
                    pos,
                    del: s.len(),
                    ins: String::new(),
                });
                pos += s.len();
            }
            dissimilar::Chunk::Insert(s) => out.push(Patch {
                pos,
                del: 0,
                ins: s.to_string(),
            }),
        }
    }
    // 같은 위치의 delete+insert를 하나로 합친다 (교체)
    let mut merged: Vec<Patch> = Vec::with_capacity(out.len());
    for p in out {
        if let Some(last) = merged.last_mut() {
            if last.pos == p.pos && last.ins.is_empty() && p.del == 0 {
                last.ins = p.ins;
                continue;
            }
        }
        merged.push(p);
    }
    merged
}

/// base→cur diff로 만든 좌표 변환표. 에디터가 본 텍스트(base)와 CRDT의
/// 현재 텍스트(cur)가 다를 때(그 사이 원격 머지 등) 패치 위치를 옮긴다.
struct PosMap {
    /// (base 시작, base 길이, cur 시작, equal 여부)
    segs: Vec<(usize, usize, usize, bool)>,
    cur_len: usize,
}

impl PosMap {
    fn new(base: &str, cur: &str) -> Self {
        let mut segs = Vec::new();
        let (mut b, mut c) = (0usize, 0usize);
        for chunk in dissimilar::diff(base, cur) {
            match chunk {
                dissimilar::Chunk::Equal(s) => {
                    segs.push((b, s.len(), c, true));
                    b += s.len();
                    c += s.len();
                }
                dissimilar::Chunk::Delete(s) => {
                    segs.push((b, s.len(), c, false));
                    b += s.len();
                }
                dissimilar::Chunk::Insert(s) => c += s.len(),
            }
        }
        PosMap {
            segs,
            cur_len: cur.len(),
        }
    }

    fn identity(len: usize) -> Self {
        PosMap {
            segs: vec![(0, len, 0, true)],
            cur_len: len,
        }
    }

    fn map(&self, p: usize) -> usize {
        for &(bs, blen, cs, equal) in &self.segs {
            if p < bs + blen {
                return if equal { cs + (p - bs) } else { cs };
            }
        }
        self.cur_len
    }
}

fn fnv1a64(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for &b in *part {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

/// 결정적 client id: 같은 (용도, 문서, 상태, 내용)이면 어느 기기든 같은 값.
/// JS Yjs와의 호환을 위해 53비트로 자른다.
fn deterministic_client(parts: &[&[u8]]) -> ClientID {
    let h = fnv1a64(parts) & ((1 << 53) - 1);
    ClientID::new(if h == 0 { 1 } else { h })
}

// ---------------------------------------------------------------------------
// 저장소
// ---------------------------------------------------------------------------

pub struct CollabStore {
    root: PathBuf,
    actor: String,
    compact_threshold: u64,
}

type LoadedDoc = (
    Doc,
    TextRef,
    bool,         /* 데이터 존재 여부 */
    Vec<PathBuf>, /* 읽은 스냅샷 */
);

impl CollabStore {
    pub fn new(root: impl Into<PathBuf>, actor: String) -> Self {
        CollabStore {
            root: root.into(),
            actor,
            compact_threshold: COMPACT_THRESHOLD,
        }
    }

    #[cfg(test)]
    fn with_threshold(root: impl Into<PathBuf>, actor: String, threshold: u64) -> Self {
        CollabStore {
            root: root.into(),
            actor,
            compact_threshold: threshold,
        }
    }

    fn doc_dir(&self, id: &str) -> PathBuf {
        self.root.join(DATA_DIR).join("docs").join(id)
    }

    fn own_log(&self, id: &str) -> PathBuf {
        self.doc_dir(id).join(format!("log-{}.y", self.actor))
    }

    pub fn has_doc(&self, id: &str) -> bool {
        valid_id(id) && self.doc_dir(id).is_dir()
    }

    /// 스냅샷 + 모든 로그를 합쳐 문서를 복원한다
    fn load(&self, id: &str) -> io::Result<LoadedDoc> {
        let doc = Doc::with_options(Options {
            skip_gc: false,
            ..Options::default()
        });
        let text = doc.get_or_insert_text(TEXT_ROOT);
        let dir = self.doc_dir(id);
        let mut found = false;
        let mut snaps = Vec::new();
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return Ok((doc, text, false, snaps)),
        };
        let mut txn = doc.transact_mut();
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.starts_with("snap-") && name.ends_with(".y") {
                if let Ok(bytes) = fs::read(&path) {
                    if apply_bytes(&mut txn, &bytes) {
                        found = true;
                    }
                    snaps.push(path);
                }
            } else if name.starts_with("log-") && name.ends_with(".y") {
                if let Ok(bytes) = fs::read(&path) {
                    for frame in parse_frames(&bytes) {
                        if apply_bytes(&mut txn, frame) {
                            found = true;
                        }
                    }
                }
            }
        }
        drop(txn);
        Ok((doc, text, found, snaps))
    }

    /// 문서의 현재 텍스트 (협업 데이터가 없으면 None)
    pub fn doc_text(&self, id: &str) -> Option<String> {
        if !valid_id(id) {
            return None;
        }
        let (doc, text, found, _) = self.load(id).ok()?;
        found.then(|| text.get_string(&doc.transact()))
    }

    /// 에디터 저장: base(에디터가 마지막으로 본 텍스트) 대비 new의 변경을
    /// CRDT에 적용하고 합쳐진 최종 텍스트를 돌려준다. base와 CRDT 현재
    /// 텍스트가 다르면(그 사이 원격 머지) 패치 위치를 변환해 3-way 머지한다.
    pub fn save_text(&self, id: &str, base: &str, new: &str) -> io::Result<String> {
        if !valid_id(id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid doc id",
            ));
        }
        let (doc, text, found, snaps) = self.load(id)?;
        let sv0 = doc.transact().state_vector();

        if !found && !base.is_empty() {
            // 신규/고아 문서의 기반 텍스트는 결정적으로 깔아 두 클라이언트가
            // 동시에 같은 파일을 처음 만져도 중복되지 않게 한다
            let update = foundation_update(id, base, &sv0);
            let mut txn = doc.transact_mut();
            apply_bytes(&mut txn, &update);
        }

        let cur = text.get_string(&doc.transact());
        let patches = diff_patches(base, new);
        let map = if cur == base {
            PosMap::identity(base.len())
        } else {
            PosMap::new(base, &cur)
        };
        {
            let mut txn = doc.transact_mut();
            for p in patches.iter().rev() {
                let start = map.map(p.pos);
                let end = map.map(p.pos + p.del);
                if end > start {
                    text.remove_range(&mut txn, start as u32, (end - start) as u32);
                }
                if !p.ins.is_empty() {
                    text.insert(&mut txn, start as u32, &p.ins);
                }
            }
        }
        let update = doc.transact().encode_diff_v1(&sv0);
        self.append_own_log(id, &update)?;
        self.maybe_compact(id, &doc, &snaps)?;
        let merged = text.get_string(&doc.transact());
        Ok(merged)
    }

    /// 에디터 저장 한 사이클: `synapse_id` 보장 → 디스크의 외부 편집 흡수 →
    /// base→content 변경을 CRDT에 기록 → 합쳐진 텍스트를 .md에 원자 쓰기.
    /// 돌려준 텍스트가 곧 디스크와 CRDT의 최종 내용이다.
    pub fn save_doc_file(&self, file: &Path, content: &str, base: &str) -> io::Result<String> {
        let owned;
        let (id, content) = match extract_doc_id(content) {
            Some(id) => (id, content),
            None => {
                let id = new_doc_id();
                owned = inject_doc_id(content, &id);
                (id, owned.as_str())
            }
        };
        // 에디터가 모르는 디스크상의 외부 편집을 먼저 흡수해 유실을 막는다
        if let Ok(disk) = fs::read_to_string(file) {
            if disk != base {
                let _ = self.absorb_external(&id, &disk);
            }
        }
        let merged = self.save_text(&id, base, content)?;
        crate::fs_io::atomic_write(file, &merged)?;
        Ok(merged)
    }

    /// 외부 편집 수용: CRDT 텍스트를 디스크 텍스트로 수렴시킨다.
    /// 결정적이라 여러 클라이언트가 같은 상태에서 같은 텍스트를 흡수해도
    /// 합치면 한 번만 반영된다. 변경이 있었으면 true.
    pub fn absorb_external(&self, id: &str, disk: &str) -> io::Result<bool> {
        if !valid_id(id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid doc id",
            ));
        }
        let (doc, text, found, _) = self.load(id)?;
        let sv0 = doc.transact().state_vector();
        if !found {
            if disk.is_empty() {
                return Ok(false);
            }
            let update = foundation_update(id, disk, &sv0);
            self.append_own_log(id, &update)?;
            return Ok(true);
        }
        let cur = text.get_string(&doc.transact());
        if cur == disk {
            return Ok(false);
        }
        let update = deterministic_patch(id, &doc, &sv0, &cur, disk, b"absorb");
        self.append_own_log(id, &update)?;
        Ok(true)
    }

    /// 충돌 해소용 3-way 흡수: base 대비 side의 변경을 현재 CRDT 텍스트
    /// 위치로 변환해 결정적으로 적용하고 최종 텍스트를 돌려준다.
    pub fn absorb_three_way(&self, id: &str, base: &str, side: &str) -> io::Result<String> {
        if !valid_id(id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid doc id",
            ));
        }
        let (doc, text, found, _) = self.load(id)?;
        let sv0 = doc.transact().state_vector();
        if !found && !base.is_empty() {
            let update = foundation_update(id, base, &sv0);
            let mut txn = doc.transact_mut();
            apply_bytes(&mut txn, &update);
        }
        let cur = text.get_string(&doc.transact());
        if cur == side {
            let update = doc.transact().encode_diff_v1(&sv0);
            if !found {
                self.append_own_log(id, &update)?;
            }
            return Ok(cur);
        }
        // 결정적 client로 side 패치를 적용한 업데이트를 만든다
        let sv_now = doc.transact().state_vector();
        let client = deterministic_client(&[
            b"three-way",
            id.as_bytes(),
            &encode_sv(&sv_now),
            base.as_bytes(),
            side.as_bytes(),
        ]);
        let tmp = Doc::with_options(Options::with_client_id(client));
        let tmp_text = tmp.get_or_insert_text(TEXT_ROOT);
        {
            let mut txn = tmp.transact_mut();
            let full = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            apply_bytes(&mut txn, &full);
        }
        let patches = diff_patches(base, side);
        let map = if cur == base {
            PosMap::identity(base.len())
        } else {
            PosMap::new(base, &cur)
        };
        {
            let mut txn = tmp.transact_mut();
            for p in patches.iter().rev() {
                let start = map.map(p.pos);
                let end = map.map(p.pos + p.del);
                if end > start {
                    tmp_text.remove_range(&mut txn, start as u32, (end - start) as u32);
                }
                if !p.ins.is_empty() {
                    tmp_text.insert(&mut txn, start as u32, &p.ins);
                }
            }
        }
        let update = tmp.transact().encode_diff_v1(&sv0);
        self.append_own_log(id, &update)?;
        let merged = tmp_text.get_string(&tmp.transact());
        Ok(merged)
    }

    fn append_own_log(&self, id: &str, update: &[u8]) -> io::Result<()> {
        if update_is_empty(update) {
            return Ok(());
        }
        let path = self.own_log(id);
        fs::create_dir_all(path.parent().unwrap())?;
        let mut frame = Vec::with_capacity(4 + update.len());
        frame.extend_from_slice(&(update.len() as u32).to_le_bytes());
        frame.extend_from_slice(update);
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)?;
        f.write_all(&frame)
    }

    /// 자기 로그가 임계치를 넘으면 전체 상태를 스냅샷으로 굳히고
    /// 자기 로그를 비운다. 방금 읽어들인(=포함된) 옛 스냅샷은 지운다.
    fn maybe_compact(&self, id: &str, doc: &Doc, loaded_snaps: &[PathBuf]) -> io::Result<()> {
        let own = self.own_log(id);
        let size = fs::metadata(&own).map(|m| m.len()).unwrap_or(0);
        if size <= self.compact_threshold {
            return Ok(());
        }
        let snapshot = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let name = format!("snap-{:016x}.y", fnv1a64(&[&snapshot]));
        let path = self.doc_dir(id).join(&name);
        if !path.exists() {
            crate::fs_io::atomic_write_bytes(&path, &snapshot)?;
        }
        fs::write(&own, [])?; // 자기 로그 truncate (자기 파일이므로 충돌 없음)
        for old in loaded_snaps {
            if old != &path {
                let _ = fs::remove_file(old);
            }
        }
        Ok(())
    }
}

/// 빈 diff 업데이트(헤더만 있는)인지 — 추가할 내용이 없으면 로그를 더럽히지 않는다
fn update_is_empty(update: &[u8]) -> bool {
    match Update::decode_v1(update) {
        Ok(u) => u.state_vector().is_empty() && u.delete_set().is_empty(),
        Err(_) => true,
    }
}

fn apply_bytes(txn: &mut yrs::TransactionMut, bytes: &[u8]) -> bool {
    match Update::decode_v1(bytes) {
        Ok(update) => txn.apply_update(update).is_ok(),
        Err(_) => false, // 손상 프레임은 건너뛴다 (다음 압축 때 자연 정리)
    }
}

fn encode_sv(sv: &StateVector) -> Vec<u8> {
    use yrs::updates::encoder::Encode;
    sv.encode_v1()
}

/// 기반 텍스트를 결정적 client id로 깐 업데이트. 같은 (id, 텍스트)면
/// 어떤 클라이언트가 만들어도 바이트 단위로 동일하다.
fn foundation_update(id: &str, base: &str, sv0: &StateVector) -> Vec<u8> {
    let client = deterministic_client(&[b"foundation", id.as_bytes(), base.as_bytes()]);
    let tmp = Doc::with_options(Options::with_client_id(client));
    let text = tmp.get_or_insert_text(TEXT_ROOT);
    {
        let mut txn = tmp.transact_mut();
        text.insert(&mut txn, 0, base);
    }
    let update = tmp.transact().encode_diff_v1(sv0);
    update
}

/// cur→target 패치를 결정적 client id로 적용한 업데이트를 만든다
fn deterministic_patch(
    id: &str,
    doc: &Doc,
    sv0: &StateVector,
    cur: &str,
    target: &str,
    purpose: &[u8],
) -> Vec<u8> {
    let sv_now = doc.transact().state_vector();
    let client = deterministic_client(&[
        purpose,
        id.as_bytes(),
        &encode_sv(&sv_now),
        target.as_bytes(),
    ]);
    let tmp = Doc::with_options(Options::with_client_id(client));
    let text = tmp.get_or_insert_text(TEXT_ROOT);
    {
        let mut txn = tmp.transact_mut();
        let full = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        apply_bytes(&mut txn, &full);
    }
    {
        let mut txn = tmp.transact_mut();
        let patches = diff_patches(cur, target);
        for p in patches.iter().rev() {
            if p.del > 0 {
                text.remove_range(&mut txn, p.pos as u32, p.del as u32);
            }
            if !p.ins.is_empty() {
                text.insert(&mut txn, p.pos as u32, &p.ins);
            }
        }
    }
    let update = tmp.transact().encode_diff_v1(sv0);
    update
}

/// git 충돌 해소용 로그 합집합: ours의 프레임 순서를 유지하고 theirs에만
/// 있는 프레임을 덧붙인다. 로그는 append-only CRDT 업데이트라 중복만
/// 제거하면 어떤 순서로 합쳐도 안전하다.
pub fn merge_log_bytes(ours: &[u8], theirs: &[u8]) -> Vec<u8> {
    let mut seen: std::collections::HashSet<&[u8]> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(ours.len() + theirs.len());
    for frame in parse_frames(ours).into_iter().chain(parse_frames(theirs)) {
        if seen.insert(frame) {
            out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
            out.extend_from_slice(frame);
        }
    }
    out
}

fn parse_frames(bytes: &[u8]) -> Vec<&[u8]> {
    let mut frames = Vec::new();
    let mut pos = 0usize;
    while pos + 4 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        if pos + len > bytes.len() {
            break; // 잘린 꼬리 프레임은 무시
        }
        frames.push(&bytes[pos..pos + len]);
        pos += len;
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path, actor: &str) -> CollabStore {
        CollabStore::new(dir, actor.to_string())
    }

    /// git 머지를 모사: 두 워크스페이스의 .synapse 파일을 합집합으로 맞춘다
    fn merge_dirs(a: &Path, b: &Path) {
        for (src, dst) in [(a, b), (b, a)] {
            let src_dir = src.join(DATA_DIR);
            if !src_dir.exists() {
                continue;
            }
            for entry in walkdir(&src_dir) {
                let rel = entry.strip_prefix(src).unwrap();
                let target = dst.join(rel);
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::copy(&entry, &target).unwrap();
            }
        }
    }

    fn walkdir(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.filter_map(Result::ok) {
                let p = e.path();
                if p.is_dir() {
                    out.extend(walkdir(&p));
                } else {
                    out.push(p);
                }
            }
        }
        out
    }

    #[test]
    fn doc_id_inject_extract_replace() {
        let id = new_doc_id();
        assert!(valid_id(&id));

        // frontmatter 없는 문서
        let injected = inject_doc_id("# 제목\n본문", &id);
        assert_eq!(extract_doc_id(&injected).as_deref(), Some(id.as_str()));
        assert!(injected.contains("# 제목"));

        // 기존 frontmatter 보존 + 주입
        let with_fm = inject_doc_id("---\ntitle: x\n---\n\n본문", &id);
        assert!(with_fm.contains("title: x"));
        assert_eq!(extract_doc_id(&with_fm).as_deref(), Some(id.as_str()));

        // 교체
        let id2 = new_doc_id();
        let replaced = inject_doc_id(&with_fm, &id2);
        assert_eq!(extract_doc_id(&replaced).as_deref(), Some(id2.as_str()));
        assert_eq!(replaced.matches(ID_KEY).count(), 1);

        // 악성 id는 무시된다
        assert!(extract_doc_id("---\nsynapse_id: ../../evil\n---\n\nx").is_none());
    }

    #[test]
    fn save_roundtrip_and_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path(), "actor-a");
        let id = new_doc_id();
        let text = "---\nsynapse_id: x\n---\n\n# 노트\n내용";
        let saved = s.save_text(&id, "", text).unwrap();
        assert_eq!(saved, text);
        // 새 스토어 인스턴스로 다시 읽어도 같다
        assert_eq!(store(tmp.path(), "actor-a").doc_text(&id).unwrap(), text);
    }

    #[test]
    fn save_doc_file_mints_id_and_absorbs_disk_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path(), "actor-a");
        let file = tmp.path().join("note.md");

        // 첫 저장: id가 없으면 발급되어 frontmatter에 들어간다
        let v1 = s.save_doc_file(&file, "# 제목\n", "").unwrap();
        let id = extract_doc_id(&v1).expect("id가 주입되어야 한다");
        assert_eq!(fs::read_to_string(&file).unwrap(), v1);
        assert_eq!(s.doc_text(&id).unwrap(), v1);

        // 에디터(base=v1)가 모르는 사이 디스크가 외부 도구로 수정됨
        let external = format!("{v1}\n외부 추가 줄\n");
        fs::write(&file, &external).unwrap();
        // 에디터는 v1 기준으로 자기 편집을 저장 — 외부 줄이 보존되어야 한다
        let edited = v1.replace("# 제목", "# 제목 (수정)");
        let merged = s.save_doc_file(&file, &edited, &v1).unwrap();
        assert!(merged.contains("# 제목 (수정)"), "{merged}");
        assert!(merged.contains("외부 추가 줄"), "{merged}");
        assert_eq!(fs::read_to_string(&file).unwrap(), merged);
    }

    #[test]
    fn concurrent_edits_converge_without_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws_a, ws_b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&ws_a).unwrap();
        fs::create_dir_all(&ws_b).unwrap();
        let a = store(&ws_a, "actor-a");
        let b = store(&ws_b, "actor-b");
        let id = new_doc_id();
        let base = "첫 줄\n둘째 줄\n셋째 줄\n";

        a.save_text(&id, "", base).unwrap();
        merge_dirs(&ws_a, &ws_b); // B가 클론한 상황

        // 동시 편집: A는 앞에, B는 뒤에
        let a_text = a
            .save_text(&id, base, "A의 머리말\n첫 줄\n둘째 줄\n셋째 줄\n")
            .unwrap();
        let b_text = b
            .save_text(&id, base, "첫 줄\n둘째 줄\n셋째 줄\nB의 꼬리말\n")
            .unwrap();
        assert_ne!(a_text, b_text);

        merge_dirs(&ws_a, &ws_b); // git pull/push 모사
        let merged_a = a.doc_text(&id).unwrap();
        let merged_b = b.doc_text(&id).unwrap();
        assert_eq!(merged_a, merged_b);
        assert!(merged_a.contains("A의 머리말"));
        assert!(merged_a.contains("B의 꼬리말"));
        assert!(merged_a.contains("둘째 줄"));
    }

    #[test]
    fn stale_base_translates_positions() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path(), "actor-a");
        let id = new_doc_id();
        let base = "hello world";
        s.save_text(&id, "", base).unwrap();
        // 그 사이 CRDT가 원격 머지로 변했다 (hello → HELLO)
        s.save_text(&id, base, "HELLO world").unwrap();
        // 에디터는 여전히 옛 base 기준으로 끝에 덧붙인다
        let merged = s.save_text(&id, base, "hello world!").unwrap();
        assert_eq!(merged, "HELLO world!");
    }

    #[test]
    fn absorb_external_is_deterministic_across_clients() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws_a, ws_b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&ws_a).unwrap();
        fs::create_dir_all(&ws_b).unwrap();
        let a = store(&ws_a, "actor-a");
        let b = store(&ws_b, "actor-b");
        let id = new_doc_id();
        let base = "원래 내용\n";
        a.save_text(&id, "", base).unwrap();
        merge_dirs(&ws_a, &ws_b);

        // 같은 외부 편집을 양쪽이 따로 흡수
        let external = "원래 내용\n외부에서 추가된 줄\n";
        assert!(a.absorb_external(&id, external).unwrap());
        assert!(b.absorb_external(&id, external).unwrap());

        merge_dirs(&ws_a, &ws_b);
        // 중복 삽입 없이 한 번만 반영되어야 한다
        let merged = a.doc_text(&id).unwrap();
        assert_eq!(merged, external);
        assert_eq!(merged.matches("외부에서 추가된 줄").count(), 1);
        assert_eq!(a.doc_text(&id).unwrap(), b.doc_text(&id).unwrap());
    }

    #[test]
    fn foundation_is_deterministic_for_orphan_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws_a, ws_b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&ws_a).unwrap();
        fs::create_dir_all(&ws_b).unwrap();
        let a = store(&ws_a, "actor-a");
        let b = store(&ws_b, "actor-b");
        let id = new_doc_id();
        let legacy = "레거시 파일 내용\n";

        // 같은 레거시 텍스트를 양쪽이 동시에 처음 저장 (서로 다른 편집)
        let a_text = a
            .save_text(&id, legacy, "레거시 파일 내용\nA 추가\n")
            .unwrap();
        let b_text = b
            .save_text(&id, legacy, "레거시 파일 내용\nB 추가\n")
            .unwrap();
        assert!(a_text.contains("A 추가"));
        assert!(b_text.contains("B 추가"));

        merge_dirs(&ws_a, &ws_b);
        let merged = a.doc_text(&id).unwrap();
        assert_eq!(merged, b.doc_text(&id).unwrap());
        // 기반 텍스트가 중복되지 않아야 한다
        assert_eq!(merged.matches("레거시 파일 내용").count(), 1);
        assert!(merged.contains("A 추가"));
        assert!(merged.contains("B 추가"));
    }

    #[test]
    fn compaction_truncates_log_and_keeps_text() {
        let tmp = tempfile::tempdir().unwrap();
        let s = CollabStore::with_threshold(tmp.path(), "actor-a".into(), 256);
        let id = new_doc_id();
        let mut text = String::from("시작\n");
        s.save_text(&id, "", &text).unwrap();
        for i in 0..50 {
            let next = format!("{text}{i}번째 줄\n");
            s.save_text(&id, &text, &next).unwrap();
            text = next;
        }
        // 압축이 일어났다: 자기 로그는 비고 스냅샷이 생겼다
        let log_size = fs::metadata(s.own_log(&id)).map(|m| m.len()).unwrap_or(0);
        assert!(log_size < 256, "log was not compacted: {log_size} bytes");
        let snaps: Vec<_> = fs::read_dir(s.doc_dir(&id))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("snap-"))
            .collect();
        assert!(!snaps.is_empty());
        // 내용은 온전하다
        assert_eq!(store(tmp.path(), "actor-a").doc_text(&id).unwrap(), text);
    }

    #[test]
    fn three_way_absorb_merges_divergent_side() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path(), "actor-a");
        let id = new_doc_id();
        let base = "공통 기반\n";
        s.save_text(&id, "", base).unwrap();
        s.save_text(&id, base, "공통 기반\n내 편집\n").unwrap();
        // 다른 쪽(side)은 base에서 다른 방향으로 편집했다
        let merged = s
            .absorb_three_way(&id, base, "공통 기반\n상대 편집\n")
            .unwrap();
        assert!(merged.contains("내 편집"));
        assert!(merged.contains("상대 편집"));
        assert_eq!(merged.matches("공통 기반").count(), 1);
    }
}
