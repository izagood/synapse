# Synapse 개발 가이드

Tauri 2 + React(TypeScript) 마크다운 노트 앱.

- `src/` — 프론트엔드 (React, zustand, tiptap). 테스트: vitest
- `crates/synapse-core/` — GUI 비의존 Rust 코어 로직. 테스트: cargo test
- `src-tauri/` — Tauri 셸 (네이티브/플랫폼 코드, 얇은 바인딩만)

## 자주 쓰는 명령어

```bash
npm run typecheck            # tsc --noEmit
npm test                     # vitest run
npm run build                # typecheck + vite build
cargo test                   # crates/synapse-core 에서 실행
cargo check                  # src-tauri 에서 실행
```

## 개발 컨벤션

### 1. 기능에는 테스트가 따라온다

- 새 기능·버그 수정에는 해당 동작을 검증하는 테스트를 함께 추가한다.
  - TS 로직: 대상 파일과 같은 폴더에 `*.test.ts` (vitest).
    예: `src/features/editor/roundtrip.test.ts`, `src/stores/settings.test.ts`
  - Rust 로직: 테스트 가능한 부분은 `crates/synapse-core`에 두고 단위 테스트를
    작성한다. `src-tauri`에는 Tauri/플랫폼 바인딩만 남긴다.
- UI나 Tauri API에 묶인 코드는 로직을 순수 함수로 분리해 테스트 가능하게 만든다.
- 테스트를 붙일 수 없는 변경(순수 UI/스타일 등)은 PR 본문에 사유와
  수동 검증 방법을 적는다.

### 2. 모든 변경은 PR로

- main에 직접 푸시하지 않는다. 기능 브랜치 → PR → CI 통과 확인 → 머지.
- PR 본문에는 변경 요약, 추가/수정한 테스트, 수동 검증 내용을 적는다.
- 푸시 전 로컬에서 먼저 돌린다:
  `npm run typecheck && npm test && npm run build`,
  Rust 변경 시 `cargo test`(synapse-core) / `cargo check`(src-tauri).

### 3. CI가 실패하면 원인을 고친다

- 실패한 잡의 로그를 보고 근본 원인을 분석한 뒤, 원인을 고치는 커밋을 올린다.
- 통과시키려고 테스트를 지우거나 skip 처리하거나 단언을 약화시키는 것은 금지.
  테스트 자체가 잘못된 경우에만 테스트를 고치고, PR에 사유를 남긴다.
- 가능하면 로컬에서 실패를 재현 → 수정 → 검증한 뒤 푸시한다.

### 4. PR은 항상 릴리즈 가능한 상태로

- 모든 PR은 머지 시점에 그대로 릴리즈할 수 있어야 한다. CI의
  `release-dry-run` 잡이 실제 릴리스 워크플로우와 같은 macOS 번들 빌드를
  드라이런해서 이를 검증한다 (통과 못 하면 머지하지 않는다).
- 버전을 올릴 때는 `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml` 세 곳을 함께 올린다. CI가 일치 여부를 검사한다.
- 릴리스 절차: 세 버전을 올려 머지한 뒤
  `git tag vX.Y.Z && git push origin vX.Y.Z`
  → `release-macos.yml`이 .dmg를 GitHub Releases에 올린다.
