//! Stateless 문자 단위 3-way 병합.
//!
//! CRDT(yrs)를 **일회용 알고리즘**으로만 쓴다: base 텍스트로 기반 문서를
//! 만들고, base→mine / base→theirs 두 패치를 각각 결정적 client id로
//! 독립 적용한 뒤 업데이트를 합친다. 함수 밖에 남는 상태가 없으므로
//! "디스크와 CRDT의 발산"이라는 실패 클래스가 존재하지 않는다.
//!
//! 결정성: client id를 (base, side) 내용 해시로 유도하므로
//! - 두 기기가 같은 (base, mine, theirs)를 병합하면 바이트 단위 동일 결과
//! - 완전히 동일한 편집(mine == theirs)은 조기 반환으로 중복이 없다.
//!   부분적으로 겹치는 동일 삽입(예: 양쪽이 base에 같은 줄을 각자 다른
//!   편집과 함께 추가한 경우)은 client id가 side 전체 문자열을 해시하므로
//!   중복될 수 있다 — 다만 양쪽 내용은 모두 보존된다(소실 없음).
//!   이는 삭제된 옛 CRDT 저장 계층의 3-way 병합과 동일한 특성이며,
//!   어색한 중복 결과는 git 히스토리로 복구한다.
//! - 입력 순서(mine/theirs 스왑)에도 대칭
//!
//! `diff_patches`/`Patch`/`fnv1a64`/`det_client`는 구 `collab.rs`(삭제됨)에서
//! 이식했다. yrs `Options::default()` / `Options::with_client_id()`는 0.27 기준
//! `offset_kind: OffsetKind::Bytes`가 기본값이라 `diff_patches`가 만드는
//! 바이트 오프셋을 그대로 yrs Text API에 넘길 수 있다 (구 구현과 동일).

use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Options, ReadTxn, StateVector, Text, Transact, Update};

const TEXT_ROOT: &str = "content";

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
fn det_client(parts: &[&[u8]]) -> yrs::ClientID {
    let h = fnv1a64(parts) & ((1 << 53) - 1);
    yrs::ClientID::new(if h == 0 { 1 } else { h })
}

fn apply_bytes(txn: &mut yrs::TransactionMut, bytes: &[u8]) {
    if let Ok(update) = Update::decode_v1(bytes) {
        let _ = txn.apply_update(update);
    }
}

/// base 전문을 결정적 client로 삽입한 "기반 업데이트" (전체 상태 인코딩)
fn foundation_update(base: &str) -> Vec<u8> {
    let doc = Doc::with_options(Options::with_client_id(det_client(&[
        b"base",
        base.as_bytes(),
    ])));
    let text = doc.get_or_insert_text(TEXT_ROOT);
    if !base.is_empty() {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, base);
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    update
}

/// 기반 상태 위에 base→side 패치를 결정적 client로 적용한 diff 업데이트
fn side_update(foundation: &[u8], base: &str, side: &str) -> Vec<u8> {
    let client = det_client(&[b"side", base.as_bytes(), side.as_bytes()]);
    let doc = Doc::with_options(Options::with_client_id(client));
    let text = doc.get_or_insert_text(TEXT_ROOT);
    {
        let mut txn = doc.transact_mut();
        apply_bytes(&mut txn, foundation);
    }
    let sv0 = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        for p in diff_patches(base, side).iter().rev() {
            if p.del > 0 {
                text.remove_range(&mut txn, p.pos as u32, p.del as u32);
            }
            if !p.ins.is_empty() {
                text.insert(&mut txn, p.pos as u32, &p.ins);
            }
        }
    }
    let update = doc.transact().encode_diff_v1(&sv0);
    update
}

/// base 대비 mine/theirs 두 갈래를 문자 단위 CRDT로 stateless 병합한다.
/// 패닉 없이 항상 병합 텍스트를 반환하며, mine/theirs 순서를 바꿔도
/// (대칭) 같은 결과, 같은 입력이면(결정적) 항상 같은 결과를 낸다.
pub fn merge_three_way(base: &str, mine: &str, theirs: &str) -> String {
    if mine == theirs {
        return mine.to_string();
    }
    if base == mine {
        return theirs.to_string();
    }
    if base == theirs {
        return mine.to_string();
    }
    let foundation = foundation_update(base);
    // 사전순으로 (a, b)를 고정해 mine/theirs 스왑에도 동일한 적용 순서가
    // 되도록 한다 (대칭·결정성 보장).
    let (a, b) = if mine <= theirs {
        (mine, theirs)
    } else {
        (theirs, mine)
    };
    let upd_a = side_update(&foundation, base, a);
    let upd_b = side_update(&foundation, base, b);
    let doc = Doc::new();
    let text = doc.get_or_insert_text(TEXT_ROOT);
    {
        let mut txn = doc.transact_mut();
        apply_bytes(&mut txn, &foundation);
        apply_bytes(&mut txn, &upd_a);
        apply_bytes(&mut txn, &upd_b);
    }
    let merged = text.get_string(&doc.transact());
    merged
}

/// 외부(에이전트) 편집 요청을 현재 디스크 내용과 stateless 병합하고, 남아 있는
/// 레거시 `synapse_id` frontmatter를 지연 제거한다.
///
/// `disk`(요청 처리 시점의 실제 파일 내용)를 mine으로, `new_content`(에이전트가
/// 쓰려는 내용)를 theirs로 다룬다: 동시 사용자 편집이 없다면(`disk == base`)
/// `new_content`가 그대로 반환된다.
pub fn merge_agent_edit(base: &str, disk: &str, new_content: &str) -> String {
    let merged = merge_three_way(base, disk, new_content);
    crate::docid::strip_doc_id(&merged).unwrap_or(merged)
}

/// 저장(`save_doc`)의 순수 로직: 저장 직전 디스크가 에디터의 기준(`base`)에서
/// 갈라졌으면 무조건 덮어쓰지 않고 3-way 병합으로 흡수한다.
///
/// - `disk == None`(파일 없음): 그냥 `content`를 쓴다.
/// - 디스크가 `base`와 같음(외부 변경 없음) 또는 `content`와 같음(이미 같은
///   내용): 그대로 `content` — CRDT 병합을 건너뛰는 최적화(결과는 동일하다).
/// - 그 외(디스크 발산): `merge_three_way(base, disk, content)`로 양쪽 보존.
///
/// 어느 경로든 마지막에 레거시 `synapse_id` frontmatter를 지연 제거한다.
pub fn save_merge(base: &str, disk: Option<&str>, content: &str) -> String {
    let merged = match disk {
        Some(d) if d != base && d != content => merge_three_way(base, d, content),
        _ => content.to_string(),
    };
    crate::docid::strip_doc_id(&merged).unwrap_or(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_edits_in_different_paragraphs() {
        let base = "# 제목\n\n첫 문단입니다.\n\n둘째 문단입니다.\n";
        let mine = "# 제목\n\n첫 문단입니다! 수정했어요.\n\n둘째 문단입니다.\n";
        let theirs = "# 제목\n\n첫 문단입니다.\n\n둘째 문단입니다. 추가 문장.\n";
        let merged = merge_three_way(base, mine, theirs);
        assert_eq!(
            merged,
            "# 제목\n\n첫 문단입니다! 수정했어요.\n\n둘째 문단입니다. 추가 문장.\n"
        );
    }

    #[test]
    fn merges_edits_in_same_paragraph_without_loss() {
        // markdown 산문: 문단 = 한 줄. 줄 단위 diff3라면 충돌하는 케이스.
        let base = "가나다라 마바사 아자차카 타파하\n";
        let mine = "가나다라 마바사 아자차카 타파하 그리고 끝\n";
        let theirs = "시작 가나다라 마바사 아자차카 타파하\n";
        let merged = merge_three_way(base, mine, theirs);
        assert!(merged.contains("그리고 끝"));
        assert!(merged.contains("시작 "));
    }

    #[test]
    fn symmetric_and_deterministic() {
        let base = "공통\n";
        let mine = "공통\n내 편집\n";
        let theirs = "원격 편집\n공통\n";
        let ab = merge_three_way(base, mine, theirs);
        let ba = merge_three_way(base, theirs, mine);
        assert_eq!(
            ab, ba,
            "입력 순서와 무관하게 동일해야 두 기기가 재발산하지 않는다"
        );
        assert_eq!(ab, merge_three_way(base, mine, theirs), "반복 호출 결정성");
    }

    #[test]
    fn fully_identical_edits_do_not_duplicate() {
        // mine == theirs 조기 반환 경로 — 완전히 동일한 편집은 중복이 없다.
        let base = "본문\n";
        let both = "본문\n같은 추가\n";
        assert_eq!(merge_three_way(base, both, both), both);
    }

    #[test]
    fn partially_identical_concurrent_edits_may_duplicate_but_never_lose() {
        // mine != theirs 이므로 조기 반환 경로를 타지 않는다. 양쪽이 부분적으로
        // 동일한 삽입("SAME\n")을 포함하면 client id가 side 전체 문자열을
        // 해시하므로 그 삽입이 중복될 수 있다 — 이는 허용된 특성이다.
        // 금지되는 것은 소실뿐이며, MINE/THEIRS/SAME 내용은 모두 보존되어야 한다.
        let base = "A\n";
        let mine = "A\nSAME\nMINE\n";
        let theirs = "A\nSAME\nTHEIRS\n";
        let merged = merge_three_way(base, mine, theirs);
        assert!(merged.contains("MINE"));
        assert!(merged.contains("THEIRS"));
        assert!(merged.contains("SAME"));
        assert_eq!(merged, merge_three_way(base, theirs, mine), "대칭성 유지");
    }

    #[test]
    fn one_side_unchanged_returns_other() {
        let base = "그대로\n";
        let mine = "그대로\n로컬 추가\n";
        assert_eq!(merge_three_way(base, mine, base), mine);
        assert_eq!(merge_three_way(base, base, mine), mine);
    }

    #[test]
    fn empty_base_concurrent_creation() {
        // 신규 파일을 두 기기가 동시에 만든 경우 — 양쪽 내용 모두 보존
        let merged = merge_three_way("", "로컬 신규\n", "원격 신규\n");
        assert!(merged.contains("로컬 신규"));
        assert!(merged.contains("원격 신규"));
    }

    #[test]
    fn crlf_content_survives() {
        let base = "줄1\r\n줄2\r\n";
        let mine = "줄1 수정\r\n줄2\r\n";
        let theirs = "줄1\r\n줄2\r\n줄3\r\n";
        let merged = merge_three_way(base, mine, theirs);
        assert_eq!(merged, "줄1 수정\r\n줄2\r\n줄3\r\n");
    }

    #[test]
    fn agent_edit_merges_concurrent_user_edit() {
        // 에이전트가 base 기준으로 편집을 제출하는 사이 사용자가 디스크에 다른
        // 편집을 남긴 경우 — 둘 다 보존돼야 한다(bridge `/edit` 엔드포인트 경로).
        let base = "A\n";
        let disk = "A\nuser\n";
        let new_content = "A\nagent\n";
        let merged = merge_agent_edit(base, disk, new_content);
        assert!(
            merged.contains("user"),
            "사용자 편집이 보존돼야 한다: {merged}"
        );
        assert!(
            merged.contains("agent"),
            "에이전트 편집이 보존돼야 한다: {merged}"
        );
    }

    #[test]
    fn agent_edit_returns_new_content_verbatim_when_disk_matches_base() {
        // 동시 사용자 편집이 없으면(disk == base) 에이전트 내용을 그대로 쓴다.
        let base = "A\n";
        let new_content = "A\nagent\n";
        assert_eq!(merge_agent_edit(base, base, new_content), new_content);
    }

    #[test]
    fn agent_edit_strips_legacy_synapse_id() {
        let base = "---\nsynapse_id: abc123\ntitle: t\n---\n\n본문\n";
        let new_content = "---\nsynapse_id: abc123\ntitle: t\n---\n\n수정된 본문\n";
        let merged = merge_agent_edit(base, base, new_content);
        assert_eq!(merged, "---\ntitle: t\n---\n\n수정된 본문\n");
    }

    #[test]
    fn save_merge_passthrough_when_disk_matches_base() {
        // 외부 변경이 없으면(disk == base) 에디터 내용을 그대로 쓴다.
        let base = "# 노트\n\n본문\n";
        let content = "# 노트\n\n편집된 본문\n";
        assert_eq!(save_merge(base, Some(base), content), content);
    }

    #[test]
    fn save_merge_absorbs_diverged_disk() {
        // 디스크가 base에서 갈라졌으면(외부 도구·브리지·sync가 그 사이 씀)
        // 덮어쓰지 않고 3-way 병합으로 디스크 편집과 에디터 편집을 모두 보존.
        let base = "# 노트\n\n공통 문단\n";
        let disk = "# 노트\n\n공통 문단\n\n디스크 추가\n"; // 외부에서 끝에 추가
        let content = "# 노트 (편집)\n\n공통 문단\n"; // 에디터에서 제목 변경
        let merged = save_merge(base, Some(disk), content);
        assert!(merged.contains("디스크 추가"), "디스크 편집 유실: {merged}");
        assert!(merged.contains("(편집)"), "에디터 편집 유실: {merged}");
    }

    #[test]
    fn save_merge_writes_content_when_file_missing() {
        // 파일이 없으면(disk == None) 병합 없이 에디터 내용을 그대로 쓴다.
        let content = "# 새 노트\n\n본문\n";
        assert_eq!(save_merge("", None, content), content);
    }

    #[test]
    fn save_merge_strips_legacy_synapse_id() {
        // 병합/패스스루 여부와 무관하게 마지막에 synapse_id를 지연 제거한다.
        let base = "---\nsynapse_id: x\ntitle: t\n---\n\n본문\n";
        let content = "---\nsynapse_id: x\ntitle: t\n---\n\n수정 본문\n";
        assert_eq!(
            save_merge(base, Some(base), content),
            "---\ntitle: t\n---\n\n수정 본문\n"
        );
    }
}
