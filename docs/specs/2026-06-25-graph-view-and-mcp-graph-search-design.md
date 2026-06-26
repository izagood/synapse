# Graph View 재설계 + MCP 그래프 검색 설계

작성일: 2026-06-25

## 배경

Synapse의 노트 링크 그래프는 두 곳에서 쓰인다.

- **프론트엔드 Graph View** (`src/features/graph/`) — 외부 라이브러리 없이 SVG로
  그린 정적 force-directed 그래프를 중앙 모달로 띄운다. 노드 개별 드래그가 안 되고
  화면 팬만 되며, 시각 디자인·라벨 가독성·탐색 유용성이 모두 빈약하다.
- **MCP 서버** (`crates/synapse-mcp/`, `feat/mcp-sidecar-bundle` 브랜치) — 5개 tool
  (`get_current_note`, `list_open_tabs`, `read_note`, `search_notes`, `edit_note`)을
  제공하지만 **그래프/백링크는 tool로 노출돼 있지 않다**. 코어
  (`crates/synapse-core/src/links.rs`, `retrieval.rs`)에는 `build_graph`,
  `backlinks_for`, 백링크로 인접 노트를 보강하는 retrieval 로직이 이미 있다.

이 설계는 두 축을 동등 비중으로 다룬다: (A) Graph View UI 전면 개선, (B) MCP가
링크 그래프를 기반으로 노트를 찾을 수 있도록 tool 재설계.

## 목표 / 비목표

**목표**

- Graph View를 Canvas 기반 실시간 시뮬레이션으로 고도화하고 시각·인터랙션을 개선한다.
- 코어에 그래프 쿼리 API를 신설하고 MCP tool 4종으로 노출한다.
- 순수 로직을 분리해 vitest / cargo test로 검증 가능하게 한다.

**비목표 (YAGNI)**

- 그래프 인덱스/캐시 영속화 — 1차는 on-demand 빌드. 큰 볼트에서 느려지면 후속 과제.
- 태그 공유·내용 유사도 기반 엣지 — 엣지는 링크(위키링크 + 마크다운 링크)만.
- Graph View를 독립 탭/사이드 패널로 이전 — 전체화면 모달 형태를 유지한다.
- WebGL 그래프 라이브러리 도입.

## 결정 사항 (확정된 전제)

1. **렌더링**: SVG → Canvas 2D 자체 구현 고도화 (의존성 0, 테마 통합 유지).
2. **배치**: 전체화면 모달 형태 유지(개선).
3. **그래프 빌드**: on-demand — tool/뷰 진입마다 `build_graph` 1회 실행 후 쿼리.
4. **엣지 정의**: 위키링크 `[[..]]` + 마크다운 링크 `[..](..)`만. 방향성 보존.
5. **MCP 동작 범위**: 이웃/백링크 조회, 그래프 기반 검색, 경로/연결 탐색, 허브/구조 분석.

---

## Part A — Graph View 재설계

### A1. 렌더링 엔진: SVG → Canvas 2D

- 개별 `<line>`/`<circle>`/`<text>` 엘리먼트를 단일 `<canvas>` 드로잉으로 교체한다.
- `devicePixelRatio`를 반영해 고해상도에서 선명하게 그린다.
- 한 프레임 = 엣지 → halo → 노드 → 라벨 순서로 그린다(겹침 순서 보장).
- 좌표→노드 hit-test를 별도 모듈로 분리한다. 노드 수가 적으면 단순 거리 비교,
  많아지면 화면 격자 버킷(grid bucket)으로 후보를 좁힌다.

### A2. 실시간 force 시뮬레이션 + 드래그

- 기존 `layout.ts`의 force 계산(반발/스프링/중심 끌림/경계 클램프)을 매 프레임
  `tick()`으로 전진시키는 `requestAnimationFrame` 루프로 바꾼다.
- 시스템 운동에너지가 임계 이하로 떨어지면 루프를 멈춘다(idle). 드래그·검색·필터
  변경 등 인터랙션이 들어오면 재가열(reheat)한다.
- **초기 배치는 기존 path 해시 기반 결정적 배치를 유지**한다(같은 입력 → 같은
  시작 좌표). 시뮬레이션 tick 함수는 순수 함수로 두어 단위 테스트한다.
- **노드 드래그**: 끄는 동안 해당 노드를 고정(fx/fy)하고 주변이 반응한다. 놓으면
  고정 해제(또는 고정 유지 — 기본은 해제). 드래그와 클릭은 4px 이동 임계로 구분한다
  (현행 `panned` 로직 확장).

### A3. 시각 디자인

- **노드**: degree에 비례한 크기 + 테마 accent 그라데이션. 현재 노트는 링/글로우로
  강조. 고립 노드는 작고 흐리게.
- **엣지**: 거리 기반 opacity, 가는 곡선. 포커스(호버/선택) 시 인접 엣지 강조,
  그 외 dim. 방향성 화살표는 옵션(기본 off).
- **배경**: 은은한 도트 그리드 + 테마 토큰(다크/라이트/핑크) 완전 연동.
- **라벨**: 줌 레벨에 따른 LOD — 가까우면 다 보이고, 멀면 허브(degree ≥ 2)·현재
  노트·포커스 노드만. 기존 충돌 회피(우선순위 배치) 유지. 포커스 전환은 부드럽게
  트랜지션.

### A4. 인터랙션 모델 (확정)

| 동작 | 결과 |
|------|------|
| **호버** | 이웃 강조 + 미니패널에 그 노드의 경로·백링크 수·이웃 목록 표시 (일시적, 마우스 떼면 해제) |
| **선택 안 된 노드 클릭** | 그 노드를 **선택** — 강조 + 미니패널 고정 (호버를 떼도 유지) |
| **이미 선택된 노드를 다시 클릭** | **노트 열기** (모달 닫힘) |
| **노드 드래그** | 노드 위치 이동/고정 (4px 임계로 클릭과 구분) |
| **검색** | 이름 일치 노드로 카메라 팬+줌, 일치 노드 강조 |
| **빈 공간 드래그** | 화면 팬 (현행 유지) |
| **휠 / 줌 버튼** | 줌 (현행 유지) |

- **미니패널**: 선택(또는 호버) 노드의 경로, 백링크 수, 이웃 목록을 보여준다.
  이웃 항목 클릭 시 해당 노드를 선택 대상으로 전환(점프).
- **필터 바**: 고립 노드 표시 토글, degree 임계 슬라이더, **로컬 그래프 모드**
  (현재 노트의 N홉 이웃만 표시).

### A5. 모듈 분리 (테스트 가능성)

```
src/features/graph/
  layout.ts      # force 시뮬레이션 (순수): 초기 배치 + tick()
  renderer.ts    # Canvas 드로잉 (순수): (ctx, scene, camera, theme) → void
  hitTest.ts     # 좌표 → 노드 (순수)
  camera.ts      # 줌/팬 변환 (순수): screen ↔ world 좌표
  GraphView.tsx  # React: RAF 루프·이벤트·상태(선택/호버/필터)·미니패널만
```

- `layout.ts`(tick 수렴·결정성), `hitTest.ts`(경계 케이스), `camera.ts`(좌표 왕복
  변환)에 vitest 단위 테스트를 둔다.
- `renderer.ts`는 jsdom으로 잡기 어려우므로 그릴 명령 시퀀스(scene → draw ops)를
  순수 함수로 분리해 ops 단위로 검증하고, 실제 픽셀은 ladle/E2E 시각 회귀로 본다.

---

## Part B — MCP 그래프 검색 재설계

### B1. 코어 그래프 쿼리 API

`crates/synapse-core/src/graph_query.rs` 신설 (`links.rs` 위에 구축). 각 함수는
GUI 비의존 순수 로직으로 cargo 단위 테스트한다.

```rust
// 이웃/백링크 조회
pub enum Direction { Out, In, Both }
pub fn neighbors(root: &Path, target: &Path, dir: Direction, depth: usize)
    -> Result<Vec<NeighborNote>, E>;
// NeighborNote { path, name, distance(홉 수), via_snippet }

// 그래프 기반 검색: 키워드 매칭 + 링크 확장 (retrieval.rs 일반화)
pub fn graph_search(root: &Path, query: &str, hops: usize)
    -> Result<Vec<RelatedNote>, E>;
// RelatedNote { path, name, score, reason(keyword|backlink|neighbor), snippet }

// 두 노트 사이 최단 연결 경로 (BFS, 양방향 엣지로 취급)
pub fn path_between(root: &Path, from: &Path, to: &Path)
    -> Result<Option<Vec<PathStep>>, E>;
// PathStep { path, name }  (from → ... → to 순서)

// 그래프 구조 요약
pub fn graph_overview(root: &Path) -> Result<GraphOverview, E>;
// GraphOverview { node_count, edge_count, hubs: Vec<(path, degree)>,
//                 isolated: Vec<path>, component_count }
```

- `build_graph`를 재사용해 인접 리스트를 만든 뒤 쿼리한다(on-demand).
- `graph_search`는 기존 `retrieval.rs`의 "키워드 검색 → 상위 노트의 백링크로 보강"
  로직을 일반화한다: 키워드 매칭 노트를 시드로, `hops` 만큼 링크를 따라 확장하고
  매칭 키워드 수·연결 거리로 점수를 매긴다.

### B2. 새 MCP tools

`crates/synapse-mcp/src/main.rs`의 `tool_defs()`와 핸들러에 4종을 추가한다. 출력은
기존 tool과 같은 사람이 읽는 텍스트 형식(에러는 `result.isError=true`).

| tool | 입력 | 출력 요약 |
|------|------|-----------|
| `note_links` | `{ path: string, direction?: "out"\|"in"\|"both"=both, depth?: number=1 }` | 연결된 노트 목록 + 홉 수 + 링크가 등장한 스니펫 |
| `find_related` | `{ query: string, hops?: number=1 }` | 키워드 매칭 노트 + 링크로 이어진 관련 노트 (점수순, 이유 표시) |
| `note_path` | `{ from: string, to: string }` | 두 노트 사이 연결 경로(노드 시퀀스) 또는 "경로 없음" |
| `graph_overview` | `{}` | 허브(상위 degree)·고립 노트·컴포넌트 수·통계 — 탐색 시작점 추천 |

- 기존 `search_notes`(평면 전문 검색)는 유지한다. `find_related`가 그래프 확장판으로
  보완한다.
- 경로 입력은 기존 `read_note`와 동일한 규약(워크스페이스 상대/절대 경로 해석,
  루트 밖 탈출 금지)을 따른다.

### B3. 성능

- 각 tool 호출은 `build_graph`를 1회 실행(전체 워크스페이스 순회)한 뒤 쿼리한다.
  "진실의 원천 = 파일시스템" 원칙과 일치하며 구현이 단순하다.
- 큰 볼트에서 지연이 문제가 되면, 짧은 TTL 인메모리 그래프 캐시를 후속으로 도입한다
  (이번 범위 밖).

---

## 데이터 흐름

```
[Graph View]
 root → ipc.linkGraph(root) → LinkGraph(nodes, edges)
      → layout.ts (초기 배치 + RAF tick)
      → renderer.ts (Canvas 드로잉)
 사용자 이벤트 → hitTest/camera → 선택·호버·드래그 상태 → 재렌더

[MCP]
 에이전트 → synapse-mcp tool 호출
      → (HTTP 브리지) → synapse-core graph_query.*
      → build_graph(root) → 쿼리 → 텍스트 응답
```

## 에러 처리

- Graph View: `linkGraph` 실패 시 빈 그래프로 폴백(현행 유지). 노드 0개면 안내 메시지.
- MCP: 존재하지 않는 경로·루트 밖 경로·빈 그래프는 `isError=true`로 명확한 사유 반환.
  `note_path`에서 경로가 없으면 에러가 아니라 "연결 경로 없음" 정상 응답.

## 테스트 계획

- **TS**: `layout.test.ts`(tick 수렴·결정성), `hitTest.test.ts`, `camera.test.ts`,
  renderer scene-ops 테스트. 시각은 ladle 픽스처 + E2E 시각 회귀.
- **Rust**: `graph_query.rs` 단위 테스트(neighbors depth, graph_search 점수,
  path_between BFS, graph_overview 통계), MCP tool 핸들러 테스트(입력 파싱·출력 포맷·
  에러 케이스). E2E 브리지 테스트에 신규 tool 왕복 추가.

## 점진 구현 순서(제안)

1. 코어 `graph_query.rs` + 단위 테스트 (UI와 독립, 먼저 안정화).
2. MCP tool 4종 노출 + 핸들러/E2E 테스트.
3. Graph View 모듈 분리(layout/camera/hitTest) + 테스트 — 동작 동일 리팩터.
4. Canvas 렌더러 + RAF 시뮬레이션 + 드래그.
5. 시각 디자인·미니패널·필터 바·인터랙션 모델 완성.
6. ladle/E2E 시각 회귀 갱신.
