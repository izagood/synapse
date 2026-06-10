# v0.2.0 기능 추가 계획

v0.1.0 사용 피드백 기반 6개 기능. 완료 시 `v0.2.0` 태그로 릴리스한다.

## F1. 사이드바 너비 드래그 조절

- 파일 트리 우측 경계에 6px 드래그 핸들. pointer 이벤트로 너비 조절.
- 범위 180~520px, **더블클릭 시 기본값(260px) 복원** (VS Code와 동일).
- 너비는 기기·화면별 상태이므로 설정 파일이 아닌 **localStorage**에 저장 (전역 설정 오염 방지).

## F2. 원클릭 버전 업데이트

- `tauri-plugin-updater` + `tauri-plugin-process`(설치 후 재시작) 도입.
- 업데이트 피드: GitHub Releases의 `latest.json` — tauri-action이 자동 생성·업로드.
  - endpoint: `https://github.com/izagood/synapse/releases/latest/download/latest.json`
- **업데이트 서명**(앱 서명과 별개, 필수): `tauri signer generate`로 키쌍 생성
  - public key → `tauri.conf.json`에 커밋
  - private key → GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (+`..._PASSWORD`)
- UX: 앱 시작 시 1회 체크 → 새 버전이 있으면 상태바에 "⬆ v0.2.x 업데이트" 버튼 →
  클릭 한 번으로 다운로드·설치·재시작. 설정 화면에도 "업데이트 확인" 버튼.
- ⚠️ v0.1.0에는 updater가 없으므로 **v0.2.0만 수동 설치**, 이후부터 원클릭 업데이트.

## F3. Cmd+, 설정 열기

- 단축키 핸들러를 WorkspaceView에서 **App 전역으로 이동** (시작 화면에서도 동작).
- `Cmd/Ctrl + ,` → 설정 모달 토글. 기존 Ctrl+S/P와 통합 관리.

## F4. 테마·폰트 기본 설정 (VS Code 참조)

- 설정에 `editor.fontFamily` 추가 (Rust `Settings`에 serde 기본값으로 하위호환).
- UI: 폰트 패밀리 — 자주 쓰는 목록(시스템 기본/Pretendard/Noto Sans KR/모노스페이스) 셀렉트 + 직접 입력.
- 테마(시스템/라이트/다크)와 글자 크기는 v0.1에 있음 → 설정 모달 상단 "화면" 섹션으로 정리하고
  변경 즉시 미리보기 적용(이미 즉시 적용 구조).

## F5. 자동 동기화 토글 + 동기화 애니메이션

- `sync.auto`는 이미 설정에 있음 → **상태바에서 바로 켜고 끄는 토글 스위치** 추가
  (설정 모달과 동일 값, 양쪽 어디서 바꿔도 동기화됨).
- 애니메이션:
  - 동기화 진행 중: 상태 아이콘(⟳) **회전 애니메이션** (CSS keyframes)
  - 완료 시: 체크 아이콘 fade-in, 상태 텍스트 부드러운 전환
  - 자동 동기화 꺼짐: 회색 상태 표시

## F6. 커밋 메시지에 시각 포함

- `"synapse: 노트 동기화"` → `"synapse: 노트 동기화 2026-06-10 21:30:45"`
- 시각은 **프론트엔드(로컬 시간)에서 생성**해 `sync_now(root, message)` 파라미터로 전달
  (Rust에 시간 라이브러리 추가 불필요, 사용자의 로컬 타임존 그대로).
- 자동/수동/충돌 해결 커밋 모두 동일 포맷 적용. 유닛 테스트로 포맷 고정.

## 작업 순서

| 순서 | 작업 | 검증 |
|---|---|---|
| 1 | F3+F4+F6 (설정·단축키·커밋 메시지 — 의존성 없음) | vitest + cargo test |
| 2 | F1 사이드바 리사이즈 | 수동 + 빌드 |
| 3 | F5 동기화 토글·애니메이션 | vitest (스토어) |
| 4 | F2 업데이트: 키 생성 → conf/워크플로 수정 → 상태바 UI | CI 릴리스로 실검증 |
| 5 | v0.2.0 태그 → 릴리스 → 맥에서 수동 설치 1회 | 이후 릴리스부터 원클릭 |

## 사용자가 해야 할 일 (F2 업데이트 서명)

1. 키 생성 후 안내되는 **private key를 GitHub Secrets에 등록**:
   - `TAURI_SIGNING_PRIVATE_KEY` (필수), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (비밀번호 설정 시)
2. 등록 전까지 릴리스 빌드는 updater 아티팩트 없이도 성공하도록 구성한다.
