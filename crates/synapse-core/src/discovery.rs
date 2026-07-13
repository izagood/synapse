//! bridge.json discovery 파일의 순수 로직.
//!
//! 외부 터미널은 앱의 자식이 아니라 env 상속이 불가능하므로, 실행 중인 앱이
//! 전역 설정 디렉터리에 `{워크스페이스 절대경로: {port, token, pid}}`를 기록하고,
//! MCP 사이드카가 cwd의 조상 경로로 자기 워크스페이스 항목을 찾아 접속한다.
//! 파일 IO·pid 생존 확인은 src-tauri 얇은 바인딩이 담당하고, 여기엔 맵 조작과
//! 경로 매칭만 둔다(순수·테스트 가능).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Debug)]
pub struct BridgeEntry {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

pub type BridgeMap = BTreeMap<String, BridgeEntry>;

/// 워크스페이스 항목을 추가/갱신한다(같은 root면 덮어쓴다 = "마지막에 연 창").
pub fn upsert(map: &mut BridgeMap, root: &str, entry: BridgeEntry) {
    map.insert(root.to_string(), entry);
}

/// 특정 토큰(=창)이 소유한 항목을 모두 제거한다(창이 닫힐 때).
pub fn remove_by_token(map: &mut BridgeMap, token: &str) {
    map.retain(|_, e| e.token != token);
}

/// cwd의 조상 중 맵에 등록된 가장 가까운(가장 긴) 워크스페이스 항목을 돌려준다.
pub fn find_for_cwd(map: &BridgeMap, cwd: &str) -> Option<BridgeEntry> {
    let cwd = cwd.trim_end_matches('/');
    map.iter()
        .filter(|(root, _)| {
            let root = root.trim_end_matches('/');
            cwd == root || cwd.starts_with(&format!("{root}/"))
        })
        .max_by_key(|(root, _)| root.len())
        .map(|(_, e)| e.clone())
}

/// 깨진/빈 입력은 빈 맵으로 복구한다(디스커버리는 캐시일 뿐).
pub fn parse(json: &str) -> BridgeMap {
    serde_json::from_str(json).unwrap_or_default()
}

pub fn to_json(map: &BridgeMap) -> String {
    serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(port: u16, token: &str, pid: u32) -> BridgeEntry {
        BridgeEntry { port, token: token.to_string(), pid }
    }

    #[test]
    fn upsert_overwrites_same_root() {
        let mut m = BridgeMap::new();
        upsert(&mut m, "/ws", entry(1, "a", 10));
        upsert(&mut m, "/ws", entry(2, "b", 20));
        assert_eq!(m.get("/ws"), Some(&entry(2, "b", 20)));
    }

    #[test]
    fn remove_by_token_drops_only_that_window() {
        let mut m = BridgeMap::new();
        upsert(&mut m, "/ws1", entry(1, "tok-a", 10));
        upsert(&mut m, "/ws2", entry(1, "tok-b", 10));
        remove_by_token(&mut m, "tok-a");
        assert!(m.get("/ws1").is_none());
        assert!(m.get("/ws2").is_some());
    }

    #[test]
    fn find_matches_nearest_ancestor() {
        let mut m = BridgeMap::new();
        upsert(&mut m, "/home/me/notes", entry(5, "t", 1));
        // cwd가 워크스페이스 하위 폴더여도 찾는다.
        assert_eq!(find_for_cwd(&m, "/home/me/notes/daily").unwrap().port, 5);
        // 정확히 루트여도 찾는다.
        assert_eq!(find_for_cwd(&m, "/home/me/notes").unwrap().port, 5);
    }

    #[test]
    fn find_prefers_longest_match() {
        let mut m = BridgeMap::new();
        upsert(&mut m, "/a", entry(1, "t1", 1));
        upsert(&mut m, "/a/b", entry(2, "t2", 1));
        assert_eq!(find_for_cwd(&m, "/a/b/c").unwrap().port, 2);
    }

    #[test]
    fn find_rejects_non_ancestor_and_prefix_false_positive() {
        let mut m = BridgeMap::new();
        upsert(&mut m, "/home/notes", entry(1, "t", 1));
        assert!(find_for_cwd(&m, "/home/other").is_none());
        // "/home/notes-archive"는 "/home/notes"의 하위가 아니다(경계 오탐 방지).
        assert!(find_for_cwd(&m, "/home/notes-archive").is_none());
    }

    #[test]
    fn parse_recovers_from_garbage() {
        assert!(parse("not json").is_empty());
        assert!(parse("").is_empty());
    }

    #[test]
    fn roundtrip_json() {
        let mut m = BridgeMap::new();
        upsert(&mut m, "/ws", entry(51234, "tok", 999));
        assert_eq!(parse(&to_json(&m)), m);
    }
}
