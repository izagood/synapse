# Synapse

> 편집은 Notion처럼, 저장은 Markdown으로. GitHub이 곧 저장소.

Synapse는 블록 기반 WYSIWYG 에디터로 작성하고 표준 `.md`로 저장하는 노트 앱입니다.
AI가 정리해준 `.html` 문서를 안전하게 렌더링해서 보는 뷰어를 내장하고,
GitHub 로그인 한 번으로 노트 폴더를 리포지토리와 동기화합니다.

Obsidian과 달리 설정은 앱 전역 한 곳에만 두고, 폴더는 VSCode처럼
"폴더 열기"로 아무 폴더나 즉시 엽니다 — 폴더에 설정 파일을 남기지 않습니다.

## 문서

- [요구사항 정의서](docs/REQUIREMENTS.md) — 비전, 기능/비기능 요구사항, MVP 범위
- [아키텍처 설계서](docs/ARCHITECTURE.md) — 기술 스택, 구조, 핵심 설계, 마일스톤

## 기술 스택 (요약)

Tauri 2 (Rust) · React 18 + TypeScript · Tiptap(ProseMirror) · remark/unified · libgit2 · GitHub OAuth Device Flow

## 개발

요구 도구: Node.js 22+, Rust(stable), Tauri Linux 빌드 의존성([공식 가이드](https://v2.tauri.app/start/prerequisites/) — `webkit2gtk-4.1`, `gtk3` 등).

```bash
npm install

npm run dev        # 브라우저 개발 모드 (Tauri 없이 mock IPC로 UI 개발)
npm run tauri dev  # 데스크톱 앱 실행 (Tauri 빌드 의존성 필요)

npm test           # 프론트엔드 테스트 (vitest)
npm run typecheck  # TypeScript 타입체크
cargo test         # crates/synapse-core 에서 실행 — GUI 의존성 없는 코어 로직 테스트
```

### 코드 구성

- `src/` — React 프론트엔드. `src/ipc/`가 Tauri IPC 경계이며, 브라우저에서는 자동으로 mock 구현으로 전환된다.
- `src-tauri/` — Tauri 셸. 커맨드 글루만 담당하는 얇은 레이어.
- `crates/synapse-core/` — 파일 트리, 워크스페이스 레지스트리, 경로 가드 등 핵심 로직. GUI 의존성이 없어 어디서든 `cargo test`로 검증 가능.

### GitHub 로그인 설정 (배포 전 1회)

동기화 기능은 GitHub OAuth App이 필요합니다.

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App
2. **Enable Device Flow** 체크 (callback URL은 아무 값이나 가능, Device Flow만 사용)
3. 발급된 Client ID를 환경변수로 넣고 빌드:

```bash
SYNAPSE_GITHUB_CLIENT_ID=<client_id> npm run tauri build
```

### 패키징

```bash
npm run tauri build   # 플랫폼별 설치 파일 생성 (deb/AppImage/msi/dmg)
```

아이콘은 `src-tauri/icons/`에 포함되어 있고, `npx tauri icon <원본.png>`로 교체할 수 있습니다.

### 마일스톤 현황

- [x] **M0 골격** — 폴더 열기, 파일 트리, 최근 폴더
- [x] **M1 에디터** — Tiptap WYSIWYG, md 라운드트립, 자동 저장, 소스 모드, 탭
- [x] **M2 뷰어** — HTML 정화 + 샌드박스 렌더링, 렌더/소스 전환
- [x] **M3 동기화** — GitHub Device Flow 로그인, 게시/클론, 자동/수동 sync, 충돌 3택
- [x] **M4 설정/마감** — 전역 설정 UI, 빠른 열기(Ctrl+P), 테마, 패키징 설정

이후 계획(post-MVP)은 [요구사항 정의서의 FR-6](docs/REQUIREMENTS.md)을 참조: 전체 텍스트 검색,
위키링크/백링크, HTML↔MD 변환, 파일 히스토리, 슬래시 커맨드 메뉴, AI 연동.
