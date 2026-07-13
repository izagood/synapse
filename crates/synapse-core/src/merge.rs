//! Stateless 문자 단위 3-way 병합.
//!
//! CRDT(yrs)를 **일회용 알고리즘**으로만 쓴다: base 텍스트로 기반 문서를
//! 만들고, base→mine / base→theirs 두 패치를 각각 결정적 client id로
//! 독립 적용한 뒤 업데이트를 합친다. 함수 밖에 남는 상태가 없으므로
//! "디스크와 CRDT의 발산"이라는 실패 클래스가 존재하지 않는다.
//!
//! 결정성: client id를 (base, side) 내용 해시로 유도하므로
//! - 두 기기가 같은 (base, mine, theirs)를 병합하면 바이트 단위 동일 결과
//! - 양쪽이 동일한 편집을 했다면 같은 업데이트가 생성되어 중복 삽입 없음
//! - 입력 순서(mine/theirs 스왑)에도 대칭
//!
//! `diff_patches`/`Patch`/`fnv1a64`/`det_client`는 `collab.rs`에서 이식했다
//! (collab.rs는 이후 단계에서 삭제될 예정이라 import하지 않고 복사한다).
//! yrs `Options::default()` / `Options::with_client_id()`는 0.27 기준
//! `offset_kind: OffsetKind::Bytes`가 기본값이라 `diff_patches`가 만드는
//! 바이트 오프셋을 그대로 yrs Text API에 넘길 수 있다 (collab.rs와 동일).

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_edits_in_different_paragraphs() {
        let base = "# 제목\n\n첫 문단입니다.\n\n둘째 문단입니다.\n";
        let mine = "# 제목\n\n첫 문단입니다! 수정했어요.\n\n둘째 문단입니다.\n";
        let theirs = "# 제목\n\n첫 문단입니다.\n\n둘째 문단입니다. 추가 문장.\n";
        let merged = merge_three_way(base, mine, theirs);
        assert!(merged.contains("수정했어요"));
        assert!(merged.contains("추가 문장"));
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
    fn identical_concurrent_edits_do_not_duplicate() {
        let base = "본문\n";
        let both = "본문\n같은 추가\n";
        assert_eq!(merge_three_way(base, both, both), both);
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
        assert!(merged.contains("줄1 수정\r\n"));
        assert!(merged.contains("줄3\r\n"));
    }
}
