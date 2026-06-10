# Synapse 패키징 가이드 (macOS 중심)

## 0. 한눈에 보기

| 경로 | 언제 | 결과물 |
|---|---|---|
| **A. 맥에서 직접 빌드** | 개발 중 빠른 확인 | `Synapse.app` + `.dmg` (내 아키텍처용) |
| **B. GitHub Actions 릴리스** | 배포·설치용 (권장) | 유니버설 `.dmg` (Intel + Apple Silicon), GitHub Releases 자동 업로드 |

서명/공증은 선택 사항이다(§4). 서명 없이도 설치·사용 가능하지만 첫 실행 시 Gatekeeper 우회가 필요하다(§3).

## 1. 경로 A — 맥에서 직접 빌드

사전 요구사항 (1회):

```bash
xcode-select --install                                   # Xcode Command Line Tools (git 포함)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
# Node 22+: https://nodejs.org 또는 brew install node
```

빌드:

```bash
git clone https://github.com/izagood/synapse.git && cd synapse
npm install
SYNAPSE_GITHUB_CLIENT_ID=<클라이언트ID> npm run tauri build
```

결과물 위치:

- 앱: `src-tauri/target/release/bundle/macos/Synapse.app`
- 설치 이미지: `src-tauri/target/release/bundle/dmg/Synapse_<버전>_aarch64.dmg`

`Synapse.app`을 `/Applications`로 드래그하면 설치 끝. `SYNAPSE_GITHUB_CLIENT_ID` 없이 빌드하면 GitHub 동기화를 제외한 모든 기능(로컬 노트, HTML 뷰어)이 동작한다.

## 2. 경로 B — GitHub Actions 자동 릴리스 (권장)

`.github/workflows/release-macos.yml`이 이미 구성되어 있다.

**1회 설정** — 리포지토리 Settings → Secrets and variables → Actions:

| Secret | 값 |
|---|---|
| `SYNAPSE_GITHUB_CLIENT_ID` | GitHub OAuth App의 Client ID (Developer settings → OAuth Apps에서 생성, **Enable Device Flow** 체크) |

**릴리스 절차**:

```bash
# 1) 버전 올리기: package.json + src-tauri/tauri.conf.json 의 "version"
# 2) 태그 푸시
git tag v0.1.0
git push origin v0.1.0
```

약 10~15분 뒤 GitHub Releases에 유니버설 `.dmg`가 올라온다. 맥에서 내려받아 열고 `Synapse.app`을 Applications로 드래그.

## 3. 설치 후 첫 실행 (서명 없는 빌드)

Apple Developer 서명이 없으므로 처음 열 때 "확인되지 않은 개발자" 경고가 뜬다. 둘 중 하나로 해결:

- Finder에서 `Synapse.app` **우클릭 → 열기 → 열기** (한 번만 하면 됨), 또는
- 터미널에서: `xattr -cr /Applications/Synapse.app`

동기화 기능은 `git`을 사용한다 — Xcode Command Line Tools가 설치되어 있으면 포함되어 있고, 없으면 처음 git 호출 시 macOS가 설치를 안내한다.

## 4. 서명 + 공증 (선택, 배포 품질을 올릴 때)

Apple Developer Program(연 $99) 가입 후 Developer ID Application 인증서를 발급받으면 Gatekeeper 경고 없이 배포할 수 있다. `release-macos.yml`의 tauri-action 단계에 secrets만 추가하면 된다:

| Secret | 내용 |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application .p12를 base64 인코딩한 값 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 비밀번호 |
| `APPLE_SIGNING_IDENTITY` | 예: `Developer ID Application: Hong Gildong (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 공증(notarization)용 — App-specific password 사용 |

tauri-action이 이 환경변수들을 인식해 서명·공증을 자동 수행한다 (워크플로의 `env:`에 위 항목들을 추가).

## 5. 이후 계획

- **자동 업데이트**: `tauri-plugin-updater` + GitHub Releases의 `latest.json` — 서명 키가 필요하므로 §4 이후에 도입
- **Windows/Linux 빌드**: 같은 워크플로에 `matrix: [macos-14, ubuntu-22.04, windows-latest]` 확장만 하면 됨 (Linux는 `webkit2gtk` apt 설치 단계 추가 필요)
- **Homebrew cask**: 서명/공증 후 `brew install --cask synapse` 배포 검토
