# Synapse 패키징 가이드 (macOS / Windows)

## 0. 한눈에 보기

| 경로 | 언제 | 결과물 |
|---|---|---|
| **A. 맥에서 직접 빌드** | 개발 중 빠른 확인 | `Synapse.app` + `.dmg` (내 아키텍처용) |
| **B. Windows에서 직접 빌드** | Windows 설치 파일 확인 | `.msi` |
| **C. GitHub Actions 릴리스** | 배포·설치용 (권장) | 아키텍처별 `.dmg`(Apple Silicon·Intel) + Windows `.msi`, GitHub Releases 자동 업로드 |

서명/공증은 선택 사항이다(§5). 서명 없이도 설치·사용 가능하지만 첫 실행 시 macOS Gatekeeper 또는 Windows SmartScreen 우회가 필요할 수 있다.

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

## 2. 경로 B — Windows에서 직접 빌드

사전 요구사항 (1회):

- Node.js 22+
- Rust stable
- Microsoft C++ Build Tools 또는 Visual Studio Build Tools
- WebView2 Runtime (대부분의 Windows 10/11에는 기본 설치)

빌드:

```powershell
git clone https://github.com/izagood/synapse.git
cd synapse
npm install
$env:SYNAPSE_GITHUB_CLIENT_ID="<클라이언트ID>"
npm run tauri build
```

결과물 위치:

- 설치 파일: `src-tauri\target\release\bundle\msi\Synapse_<버전>_x64_en-US.msi`

동기화 기능은 시스템 `git`을 사용한다. Windows에서는 [Git for Windows](https://git-scm.com/download/win)를 설치하고 새 터미널/앱을 열어 PATH가 반영되었는지 확인한다.

## 3. 경로 C — GitHub Actions 자동 릴리스 (권장)

`.github/workflows/release-macos.yml`이 macOS + Windows 데스크톱 릴리스로 구성되어 있다. 파일명은 기존 자동 릴리스 호환성을 위해 유지한다.

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

약 10~20분 뒤 GitHub Releases에 아키텍처별 `.dmg`(Apple Silicon `_aarch64`, Intel `_x64`)와 Windows `.msi`가 올라온다.

## 4. 설치 후 첫 실행 (서명 없는 빌드)

macOS에서 Apple Developer 서명이 없으면 처음 열 때 "확인되지 않은 개발자" 경고가 뜬다. 둘 중 하나로 해결:

- Finder에서 `Synapse.app` **우클릭 → 열기 → 열기** (한 번만 하면 됨), 또는
- 터미널에서: `xattr -cr /Applications/Synapse.app`

동기화 기능은 `git`을 사용한다 — Xcode Command Line Tools가 설치되어 있으면 포함되어 있고, 없으면 처음 git 호출 시 macOS가 설치를 안내한다.

Windows에서 코드 서명이 없으면 SmartScreen 경고가 뜰 수 있다. `추가 정보` → `실행`으로 열 수 있지만, 공개 배포 품질을 올릴 때는 Authenticode 코드 서명을 추가한다.

## 5. 서명 + 공증 (선택, 배포 품질을 올릴 때)

Apple Developer Program(연 $99) 가입 후 Developer ID Application 인증서를 발급받으면 Gatekeeper 경고 없이 배포할 수 있다. `release-macos.yml`의 tauri-action 단계에 secrets만 추가하면 된다:

| Secret | 내용 |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application .p12를 base64 인코딩한 값 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 비밀번호 |
| `APPLE_SIGNING_IDENTITY` | 예: `Developer ID Application: Hong Gildong (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 공증(notarization)용 — App-specific password 사용 |

tauri-action이 이 환경변수들을 인식해 서명·공증을 자동 수행한다 (워크플로의 `env:`에 위 항목들을 추가).

Windows Authenticode 서명은 별도 인증서가 필요하다. 현재 1차 Windows 지원은 미서명 MSI를 배포하고, 서명은 후속 배포 품질 개선 항목으로 둔다.

## 6. 원클릭 업데이트

`tauri-plugin-updater`가 GitHub Releases의 `latest.json`을 피드로 사용한다.
새 버전이 릴리스되면 앱 상태바에 "⬆ 업데이트" 배지가 떠서 클릭 한 번으로 설치·재시작된다
(설정 → 업데이트에서 수동 확인도 가능).

릴리스 빌드에는 업데이트 서명 키가 필요하다:

| Secret | 내용 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri signer generate`로 만든 private key 전체 내용 |

public key는 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 커밋되어 있다.
**private key를 분실하면 기존 설치본에 업데이트를 배포할 수 없으니** 안전한 곳에 보관할 것.

## 7. 외부 도구

- `git`: 앱에 번들하지 않는다. 없으면 상태바에 안내하고 동기화만 비활성화된다.
- `claude` CLI: 앱에 번들하지 않는다. 설치 후 `claude` 명령으로 로그인하면 Agent 패널에서 감지한다. Windows에서는 설치 후 앱 재시작이 필요할 수 있다.

## 8. 이후 계획
- **Linux 빌드**: release matrix에 `ubuntu-22.04`를 추가하고 `webkit2gtk`/`gtk3` apt 설치 단계를 넣으면 된다.
- **Homebrew cask**: 서명/공증 후 `brew install --cask synapse` 배포 검토
