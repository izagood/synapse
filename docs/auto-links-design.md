# 노트 그래프 자동 연결 (auto-links) 설계

- 날짜: 2026-07-15
- 상태: 승인됨 (v1 스코프)
- 관련: `crates/synapse-core/src/links.rs`, `retrieval.rs`, `crates/synapse-mcp`, `src/features/graph/GraphView.tsx`

## 목적

synapse는 agent-native 노트앱이다. 사용자가 외부 에이전트(claude CLI 등)에게
"노트 그래프를 만들어/갱신해 달라"고 요청하면, 에이전트가 노트 간 연결 관계를
자동으로 생성·갱신한다. 사람이 링크를 일일이 걸지 않아도 그래프가 유지된다.

## 요구사항 (질의응답으로 확정)

1. **저장 형태**: 연결은 노트 본문 하단의 관리 마커 블록 안에 `[[wikilink]]`로
   삽입한다. 기존 `links.rs`/백링크/GraphView가 수정 없이 인식하고 Obsidian과
   호환된다.
2. **판단 주체**: 하이브리드. `synapse-core`가 결정적 휴리스틱으로 후보 쌍을
   계산하고, 외부 agent가 MCP 도구로 후보를 받아 의미적으로 타당한 것만 확정한다.
3. **적용 방식**: 즉시 적용. 마커 블록만 통째로 재작성하므로 멱등(idempotent)이며
   사용자가 쓴 본문은 절대 건드리지 않는다. 되돌리기는 git 동기화/히스토리.
4. **범위**: 전체(`link_candidates(root)`)와 증분(`paths` 지정) 둘 다 지원.
   agent가 git status/mtime으로 변경 노트를 골라 증분 호출한다.

## 아키텍처 & 데이터 흐름

```
사용자 → 외부 agent → synapse-mcp 사이드카 → 앱 bridge(HTTP) → synapse-core
  ① link_candidates(root, paths?, limit?) : core가 후보 쌍 + 근거 반환
  ② agent가 기존 read 도구로 노트 확인, 의미 판단
  ③ apply_links(root, links[])            : core가 마커 블록 멱등 재작성
  → 파일 watcher가 에디터/GraphView 자동 갱신
```

- **판단은 agent, 집행은 core**: LLM은 "무엇이 관련 있는가"만 결정하고,
  파일 조작은 결정적 Rust 코드(`autolink.rs` 신설)가 수행한다.
- **쓰기는 반드시 앱 bridge 경유**: 열린 탭의 미저장 버퍼는 기존 merge 경로로
  안전하게 반영한다. 앱 미실행 시 도구가 동작하지 않는 것은 기존 MCP 브리지와
  동일한 제약이다.

## 컴포넌트

### 1. `crates/synapse-core/src/autolink.rs` (신설)

**후보 스코어링** — 세 신호의 가중 합, LLM 없음:

| 신호 | 설명 | 재활용 |
|---|---|---|
| 제목 언급 | 노트 B의 제목/파일명 stem이 노트 A 본문에 등장 | `walk.rs` 순회 |
| 키워드 중복 | 상위 키워드 교집합 점수 | `retrieval.rs` 토크나이저 |
| 공통 이웃 | 기존 링크 그래프의 공통 연결 노트 수 | `links.rs::build_graph` |

- 이미 명시 링크로 연결된 쌍은 후보에서 제외한다.
- 출력: `{from, to, score, reasons[]}` 목록. `reasons`는 agent가 판단 근거로
  쓸 사람이 읽을 문자열. 기본 상한 50 (`limit` 파라미터).

**마커 블록 재작성**:

```markdown
<!-- synapse:auto-links:start -->
## 관련 노트
- [[cilium-cni]] — CNI 구현체
- [[홈랩-클러스터-구축]] — 실제 적용 사례
<!-- synapse:auto-links:end -->
```

- 블록이 있으면 그 자리에서 교체, 없으면 파일 끝에 추가.
- **마커 밖 바이트는 절대 불변** (frontmatter 포함).
- 블록은 기계 소유(machine-owned): 내용은 항상 `apply_links` 입력으로 전량
  결정된다 — 멱등성의 근원.
- `[[파일명 stem]]` 형식이므로 기존 wiki 링크 해석과 호환된다.

### 2. MCP 도구 (`crates/synapse-mcp` + bridge 엔드포인트)

- `link_candidates(root, paths?, limit?)` → 후보 목록.
  `paths` 지정 시 해당 노트가 `from`인 쌍만(증분).
- `apply_links(root, links: [{from, to, label?}])` → 파일별 결과.
  `from` 파일별로 그룹핑해 마커 블록 재작성. `label`은 `— 설명` 꼬리말.
- **선언적 계약**: 전달된 `links`가 해당 파일 블록의 *전체* 내용이 된다.
  증분 갱신 시에도 agent는 그 파일의 최종 링크 목록 전체를 전달해야 한다
  (빈 목록 전달 = 블록 비움).
- 앱 bridge에 대응 HTTP 엔드포인트를 신설하고, 사이드카는 기존 인증
  (127.0.0.1 + 토큰) 규약을 따른다.

**구현 확정 세부:**

- 후보에는 `existing`(현재 auto-links 블록에 이미 있는 연결) 플래그가 있다.
  apply_links가 선언적이므로 agent는 유지할 기존 연결도 최종 목록에 포함한다.
- 대상 stem이 다른 노트와 충돌해 위키링크가 오해석될 경우, 루트 기준 표준
  링크 `[이름](/상대/경로.md)`로 폴백한다.
- 후보 제외 기준의 "명시 링크"는 auto-links 블록 밖의 링크(사람 링크)를 뜻한다.
  공통 이웃 신호도 사람 링크만 사용한다(자동 링크의 자기 강화 방지).
- apply_links는 파일별 best-effort(한 파일 실패해도 계속, 파일별
  성공/실패/변경없음 보고)이다.

### 3. 프론트엔드

변경 없음. 파일 watcher가 디스크 변경을 에디터/트리/GraphView에 반영한다.

## 에러 처리 & 엣지 케이스

- 대상이 root 밖이거나 존재하지 않는 노트 → 해당 링크만 거부, 결과에
  `rejected[]`로 사유 반환 (부분 성공 허용).
- 마커 탐지는 `links.rs`와 동일하게 **코드펜스 내부 무시** — 코드 예시 속
  가짜 마커에 속지 않는다.
- 마커 블록 중복 존재 → 첫 블록만 교체하고 경고 반환.
- 미저장 버퍼가 열린 파일 → 디스크가 아닌 라이브 버퍼에 반영(기존 bridge 경로).
- 쓰기는 기존 `atomic_write` + `workspace_write_lock` 사용.

## 테스트 (CLAUDE.md 컨벤션)

- `autolink.rs` 단위 테스트(cargo):
  - 신호별 스코어링 (제목 언급 / 키워드 중복 / 공통 이웃)
  - 명시 링크 기존재 쌍 제외
  - **멱등성**: 같은 입력 2회 적용 = 1회 적용
  - **본문 불가침**: 마커 밖 바이트 동일 단언
  - 블록 부재 시 파일 끝 append, frontmatter 보존
  - 코드펜스 속 마커 무시, 중복 블록 경고, rejected 처리
- `synapse-mcp`: 도구 스키마/JSON-RPC 왕복 테스트(기존 패턴).
- TS 변경 없음 — watcher·GraphView 기존 테스트로 커버.

## v1 제외 (후속 과제)

- **GraphView 추론 링크 구분 표시**: 마커 블록 내 링크에 `inferred` 플래그를
  달아 점선/범례로 구분. 코어 변경은 작으나 프론트 작업이 필요해 v2로 미룸.
- 임베딩 기반 후보 스코어링 (현재는 키워드 휴리스틱).
- 앱 미실행 시 사이드카 단독 동작.
