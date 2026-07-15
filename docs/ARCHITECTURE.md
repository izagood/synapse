# Synapse 아키텍처 설계서

요구사항은 [REQUIREMENTS.md](./REQUIREMENTS.md) 참조.

## 1. 기술 스택과 선정 근거

| 레이어 | 선택 | 근거 |
| --- | --- | --- |
| 앱 셸 | **Tauri 2** (Rust) | 로컬 폴더 접근(FR-1)에 데스크톱 앱 필수. Electron 대비 설치 용량·메모리가 크게 작고(NFR-7), Rust 백엔드에서 git/파일 IO를 안전하게 처리 |
| 프론트엔드 | **React 18 + TypeScript + Vite** | 생태계, Tiptap 공식 React 바인딩 |
| 에디터 | **Tiptap (ProseMirror)** | Notion 스타일 블록 편집(FR-2)의 사실상 표준. 슬래시 커맨드·표·체크리스트 확장 존재, markdown 직렬화 가능 |
| md 직렬화 | **remark/unified + frontmatter** (TS) | 에디터 모델 ↔ CommonMark+GFM 변환, AST 기반이라 라운드트립 제어 용이 |
| git | **시스템 git CLI 서브프로세스** (Rust) | 충돌·rebase 동작이 사용자의 git과 동일하고 실제 리포지토리로 통합 테스트 가능. libgit2(git2-rs)는 TLS 의존성 빌드 부담이 커서 보류 — git 미설치 환경은 상태바에서 안내하고, 추후 libgit2 내장으로 교체 가능하도록 `GitWorkspace` 모듈에 격리 |
| GitHub 인증 | **OAuth Device Flow** + OS 키체인 (`keyring` crate) | 데스크톱에서 client secret 없이 안전한 로그인, 토큰 평문 저장 금지(NFR-4) |
| HTML sanitize | **DOMPurify** + sandboxed iframe | FR-3.2 보안 요구 |
| 상태 관리 | **Zustand** | 단순하고 충분함 |
| 검색 (post-MVP) | Rust 측 ripgrep 라이브러리(`grep` crate) | 대용량 폴더에서도 빠른 전체 검색 |

> 대안 검토: Electron(메모리/용량 무거움), 웹 앱 단독(로컬 폴더 열기 제약 — File System Access API는 Chromium 한정·권한 UX 나쁨), CodeMirror(소스 편집 중심이라 Notion UX 부적합). 웹/모바일 클라이언트는 GitHub API를 백엔드로 쓰는 별도 클라이언트로 post-MVP에 확장한다.

## 2. 전체 구조

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (React + TS, WebView)                          │
│                                                          │
│  ┌─────────┐ ┌──────────────┐ ┌────────────┐ ┌────────┐  │
│  │ FileTree│ │ Editor       │ │ HtmlViewer │ │Settings│  │
│  │ Sidebar │ │ (Tiptap)     │ │ (sandboxed │ │  UI    │  │
│  │ + Tabs  │ │ md⇄ProseMirror│ │  iframe)  │ │        │  │
│  └────┬────┘ └──────┬───────┘ └─────┬──────┘ └───┬────┘  │
│       │      Zustand stores (workspace/editor/sync/settings)
│       └─────────────┴─── Tauri invoke / events ──┴───────┤
└──────────────────────────┬───────────────────────────────┘
                           │ IPC (typed commands)
┌──────────────────────────┴───────────────────────────────┐
│  Backend (Rust, Tauri core)                              │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────┐  │
│  │ fs       │ │ git      │ │ github_auth │ │ settings │  │
│  │ 파일 IO   │ │ libgit2  │ │ device flow │ │ 전역 JSON │  │
│  │ watcher  │ │ sync 엔진 │ │ keyring     │ │ registry │  │
│  └────┬─────┘ └────┬─────┘ └──────┬──────┘ └────┬─────┘  │
└───────┼────────────┼──────────────┼─────────────┼────────┘
        ▼            ▼              ▼             ▼
   로컬 폴더      .git / GitHub   OS 키체인   ~/.config/synapse/
```

**원칙: 진실의 원천은 파일시스템이다.** 앱은 DB를 두지 않는다. 노트의 상태는 항상 디스크의 `.md`/`.html` 파일이고, git이 히스토리·동기화를 담당하며, 전역 설정만 별도 위치에 둔다. 인덱스(검색용 등)는 캐시일 뿐 언제든 재생성 가능해야 한다.

## 3. 데이터 레이아웃

### 3.1 전역 설정 (유일한 설정 위치, FR-5)

```
~/.config/synapse/            # Windows: %APPDATA%\synapse, macOS: ~/Library/Application Support/synapse
├── settings.json             # 사용자 설정 (테마, 에디터, 동기화 정책…)
├── workspaces.json           # 워크스페이스 레지스트리 (아래 참조)
└── cache/                    # 검색 인덱스 등 재생성 가능한 캐시
```

```jsonc
// settings.json
{
  "appearance": { "theme": "system", "language": "ko" },
  "editor": { "fontFamily": "Pretendard", "fontSize": 16, "autoSaveDelayMs": 1000, "assetsFolder": "assets" },
  "sync": { "auto": true, "intervalMinutes": 5, "commitMessageTemplate": "synapse: update {files}" },
  "htmlViewer": { "allowScripts": false, "allowNetwork": false }
}
```

```jsonc
// workspaces.json — 폴더에는 아무것도 남기지 않고(FR-1.6), 폴더별 상태는 여기에 경로 키로 저장
{
  "recent": ["/home/me/notes", "/home/me/work-wiki"],
  "workspaces": {
    "/home/me/notes": {
      "remote": "git@github.com:me/notes.git",
      "lastOpenedTabs": ["daily/2026-06-10.md"],
      "lastSyncedAt": "2026-06-10T08:00:00Z"
    }
  }
}
```

### 3.2 워크스페이스 (사용자 폴더)

사용자 폴더에는 노트 파일과 (동기화를 켰다면) `.git/`만 존재한다. Synapse 전용 파일은 없다.

## 4. 핵심 설계

### 4.1 에디터: Markdown 라운드트립 (FR-2)

```
열기:  .md 파일 ──remark parse──▶ mdast ──변환──▶ ProseMirror doc ──▶ Tiptap 렌더
저장:  ProseMirror doc ──변환──▶ mdast ──remark stringify──▶ .md (atomic write)
```

- 변환 레이어는 **mdast(마크다운 AST)를 단일 경유지**로 삼는다. 직접 문자열을 다루지 않으므로 라운드트립 손실을 통제할 수 있다.
- 표현 불가능한 마크다운(원시 HTML 블록 등)은 에디터에서 "소스 블록"으로 감싸 그대로 보존한다 — 다른 도구와의 호환(NFR-3) 핵심.
- frontmatter는 파싱 후 에디터 문서와 분리 보관하고 저장 시 재결합한다.
- 자동 저장은 디바운스(기본 1초) 후 atomic write(`*.tmp` 작성 → rename). 외부 변경은 fs watcher가 감지하여, 에디터가 dirty가 아니면 자동 리로드, dirty면 충돌 안내.

### 4.2 GitHub 동기화 엔진 (FR-4)

상태 머신: `idle → dirty → committing → fetching/merging/pushing → idle | conflict`

1. **로그인**: Device Flow로 코드 발급 → 사용자가 브라우저에서 승인 → 토큰을 OS 키체인에 저장. 프론트엔드는 토큰을 직접 만지지 않는다.
2. **연결**: 새 폴더 → `synapse publish`(리포 생성+초기 push) / 기존 리포 → clone 후 폴더 열기.
3. **자동 동기화 루프** (Rust 백그라운드 태스크):
   - fs watcher 이벤트 디바운스(기본 30초 무변경 시) 또는 주기 타이머 → `git add -A && commit`
   - `fetch` → 업스트림과 갈라졌으면 `merge`로 수렴(디스크가 단일 진실 — 병합 전 무조건 커밋해 로컬 편집 보존) → push. 텍스트 충돌은 문자 단위 3-way 병합으로 자동 해소하고, 바이너리·`.synapse/draw` 사이드카는 양쪽 보존
   - 자동 해소가 불가능한 충돌(삭제/수정)만 `merge --abort` 후 `conflict` 상태로 전환, UI에 충돌 파일 목록 전달 (3택은 다시 merge 기반으로 해소)
4. **충돌 해결 (MVP)**: "내 버전 유지 / 원격 버전 가져오기 / 둘 다 보존(`파일 (conflict).md` 생성)" 3택. diff 뷰 고도화는 post-MVP.
5. **UI 노출은 3상태만** (FR-4.8): ✅ 동기화됨 / 🔄 동기화 중·필요 / ⚠️ 충돌. git 용어(commit, rebase…)는 기본 UI에 노출하지 않는다.

### 4.3 HTML 뷰어 보안 (FR-3)

- `.html` 파일은 `<iframe sandbox>`(기본: `allow-same-origin` 없음, 스크립트 차단)에 DOMPurify로 정화한 내용을 srcdoc로 주입.
- 설정에서 신뢰 수준을 올리면(scripts/network 허용) 경고 후 적용. 워크스페이스 단위가 아닌 전역 설정 항목.
- 로컬 상대 경로 이미지 등은 Tauri asset protocol로 해석하되 워크스페이스 루트 밖 접근은 차단(경로 정규화 검증).

### 4.4 IPC 계약 (주요 Tauri command)

```
fs:    open_folder, list_dir, read_file, write_file_atomic, rename, delete, watch_workspace
git:   sync_status, sync_now, publish_workspace, clone_repo, resolve_conflict, file_history
auth:  github_login_start, github_login_poll, github_logout, current_user
settings: get_settings, update_settings, get_workspace_state, update_workspace_state
```

모든 command는 TS 쪽에 타입 정의를 공유(스키마 코드젠 또는 수동 타입 + 단위 테스트로 검증)한다.

## 5. 디렉토리 구조 (제안)

```
synapse/
├── src/                        # React frontend
│   ├── app/                    # 엔트리, 라우팅(시작 화면/메인), 글로벌 스타일
│   ├── features/
│   │   ├── workspace/          # 폴더 열기, 파일 트리, 탭, quick open
│   │   ├── editor/             # Tiptap 설정, 확장(슬래시 커맨드 등), md 변환 레이어
│   │   ├── html-viewer/        # sandbox iframe, sanitize, 소스 토글
│   │   ├── sync/               # 동기화 상태바, 충돌 UI, GitHub 로그인 플로우
│   │   └── settings/           # 설정 화면
│   ├── stores/                 # Zustand 스토어
│   ├── ipc/                    # Tauri invoke 래퍼 + 타입
│   └── shared/                 # 공용 컴포넌트, 유틸
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── commands/           # fs.rs, git.rs, auth.rs, settings.rs
│   │   ├── sync/               # 동기화 엔진 (상태 머신, 백그라운드 태스크)
│   │   ├── watcher.rs
│   │   └── main.rs
│   └── tauri.conf.json
├── docs/                       # 본 문서들
└── e2e/                        # WebDriver 기반 E2E (post-MVP)
```

## 6. 마일스톤

| 단계 | 내용 | 완료 기준 |
| --- | --- | --- |
| **M0 골격** | Tauri+React 부트스트랩, 폴더 열기, 파일 트리, 최근 폴더 | 임의 폴더 열고 `.md` 목록 탐색 |
| **M1 에디터** | Tiptap WYSIWYG, md 라운드트립, 자동 저장, 소스 모드, 탭 | Obsidian으로 만든 md를 열어 편집·저장해도 깨지지 않음 |
| **M2 뷰어** | HTML 샌드박스 렌더링, 소스 토글, 이미지 상대경로 | AI가 생성한 HTML 파일을 안전하게 열람 |
| **M3 동기화** | GitHub 로그인, publish/clone, 자동·수동 sync, 기본 충돌 3택 | 두 기기(또는 두 클론)에서 편집해도 수렴 |
| **M4 설정/마감** | 전역 설정 UI, quick open, 테마, 패키징(3 OS) | 설치 파일 배포 가능 |
| **M5+ (post-MVP)** | 전체 검색, 위키링크/백링크, html↔md 변환, 히스토리, AI 연동 | — |

## 7. 주요 리스크

1. **md 라운드트립 손실** — 가장 큰 기술 리스크. 초기부터 "외부 md 파일 corpus를 열고 저장해서 diff가 의미적으로 0인지" 검사하는 스냅샷 테스트를 CI에 둔다.
2. **git 충돌 UX** — 일반 사용자에게 git을 숨기는 설계(3상태/3택)를 지키지 못하면 제품 가치가 흔들린다. 자동 rebase 실패 케이스를 우선순위 높게 다룬다.
3. **대형 폴더 성능** — 파일 트리 가상화, watcher 이벤트 스로틀링을 M0부터 적용한다.
4. **HTML 보안** — AI 산출물이라도 신뢰 불가 입력으로 취급. sanitize 기본값을 끄는 옵션은 명시적 경고 뒤에만 허용한다.
