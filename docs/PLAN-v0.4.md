# PLAN v0.4 — Synapse 안에서 Claude 사용하기

MVP(v0.3) 이후 목표: Claude 앱을 오가지 않고 Synapse 안에서 바로 Claude와
대화하며 노트를 다룬다.

## 검토 결과 (2026-06)

처음 아이디어는 Claude Code **VSCode 익스텐션을 그대로 재사용**하는 것이었으나,
익스텐션은 VSCode Extension Host API 위에서만 동작해 Tauri WebView에서는
구동이 불가능하다. 대신 같은 엔진을 쓰는 공식 경로를 비교했다:

| 경로 | 평가 |
|---|---|
| **claude CLI 헤드리스 모드** (`-p --output-format stream-json`) | ✅ 채택. JetBrains 플러그인과 같은 계열. Node 런타임 불필요, 사용자의 기존 CLI 로그인(구독)을 그대로 사용. 시스템 git CLI 서브프로세스 패턴(ARCHITECTURE.md)과 동일한 철학 |
| Claude Agent SDK (TypeScript) | WebView에 Node가 없어 sidecar 번들 필요 → 용량·복잡도 증가. 추후 교체 가능하도록 CLI 연동을 `agent` 모듈에 격리 |
| ACP(Agent Client Protocol) + claude-code-acp 어댑터 | 다중 에이전트 지원이 필요해지면 재검토. 역시 Node sidecar 필요 |

주의사항:

- **인증 정책**: 개인 사용은 CLI 구독 로그인이 그대로 동작하지만, Anthropic
  정책상 서드파티 앱이 claude.ai 로그인을 제공하는 것은 금지. 배포 시
  API 키 입력 방식 추가 필요 (Phase 3).
- **stream-json 스키마**: 플래그는 공식 문서에 있으나 이벤트 JSON 세부 구조는
  비공식. 실측(claude 2.1.172) 기반으로 파싱하되, 모르는 타입은 무시하는
  방어적 파서를 `synapse-core::agent`에 격리한다.

## 아키텍처

```
React (WebView)                          Rust (Tauri)
┌─────────────────┐  invoke/events  ┌──────────────────┐   stdio    ┌────────────┐
│ AgentPanel       │ ──────────────► │ agent.rs          │ ◄────────► │ claude CLI │
│ - 메시지 스트림    │ ◄────────────── │ - spawn/kill      │ stream-json│ (headless) │
│ - 중단/새 대화    │   agent:event   │ - 파싱은 core에    │            └────────────┘
└─────────────────┘                 └──────────────────┘   cwd = 워크스페이스
```

- 메시지 1건 = `claude -p <프롬프트> --resume <세션>` 프로세스 1개.
  stream-json 한 줄 파싱(`synapse-core::agent`)마다 `agent:event`로 emit.
- 세션 ID는 워크스페이스별 localStorage에 저장해 앱 재시작 후에도 대화가
  이어진다 (`--resume`).
- cwd=워크스페이스이므로 Claude가 노트를 직접 읽는다. 파일 watcher가 이미
  외부 변경을 에디터에 반영하므로 Phase 2에서 편집을 열면 그대로 동작한다.

## 단계별 계획

### Phase 0 — PoC ✅ (v0.4.0)

- claude CLI 탐지(PATH + 표준 설치 경로, GUI 앱은 셸 PATH를 안 물려받음)
- stream-json 이벤트 스키마 실측 → `synapse-core::agent` 파서 + 단위 테스트

### Phase 1 — 채팅 패널 MVP ✅ (v0.4.0)

- 우측 AgentPanel (⇧⌘A / 액티비티 바 토글), 응답·도구 사용 표시, 중단 버튼
- 워크스페이스별 세션 유지(`--resume`), 새 대화
- CLI 미설치 안내 (git 미설치 안내와 동일 패턴)
- 안전을 위해 읽기 전용 도구만 허용: `--allowedTools Read,Glob,Grep`

### Phase 2 — Synapse 컨텍스트 통합 (다음)

- 현재 열린 노트 자동 첨부, `@파일명` 멘션
- 편집 도구 개방 + 권한 승인 UI (stream-json 양방향 control protocol)
- "응답을 노트에 삽입", 에디터 선택 텍스트를 프롬프트로
- 어시스턴트 응답 마크다운 렌더링

### Phase 3 — 고도화·배포 대비

- 설정: 모델·권한 모드 선택, API 키 인증 모드(배포 정책 대응)
- 슬래시 커맨드/스킬 노출, 멀티윈도우별 독립 세션, 대화 내역 영속화

## 리스크

| 리스크 | 완화 |
|---|---|
| stream-json 스키마 변동 | 파서를 core 한 모듈에 격리, 모르는 이벤트 무시, 실측 라인 기반 테스트 |
| CLI 미설치/미로그인 | 패널에서 안내 + 다시 확인. 추후 Agent SDK sidecar로 교체 가능 |
| 배포 시 인증 정책 | Phase 3에서 API 키 모드 추가 전까지 개인 빌드로만 사용 |
