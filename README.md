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
