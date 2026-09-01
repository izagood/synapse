# Synapse 패키징 가이드 (macOS / Windows)

## 0. 한눈에 보기

| 경로 | 언제 | 결과물 |
|---|---|---|
| **A. 맥에서 직접 빌드** | 개발 중 빠른 확인 | `Synapse.app` + `.dmg` (내 아키텍처용) |
| **B. Windows에서 직접 빌드** | Windows 설치 파일 확인 | `.msi` |
| **C. GitHub Actions 릴리스** | 배포·설치용 (권장) | 아키텍처별 `.dmg`(Apple Silicon·Intel) + Windows `.msi`, GitHub Releases 자동 업로드 |

macOS 릴리스 빌드는 Developer ID 서명 + Apple 공증을 거치므로 사용자가 우회 없이 바로 실행할 수 있다(§5). Windows는 아직 미서명이라 SmartScreen 우회가 필요할 수 있다.

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

## 4. 설치 후 첫 실행

macOS 릴리스 빌드는 Developer ID로 서명하고 Apple 공증(notarization)을 받으므로,
사용자는 DMG를 열어 앱을 드래그하고 그냥 실행하면 된다. 우클릭 → 열기나
`xattr -cr` 같은 우회는 필요 없다.

외부 터미널로 열기 기능을 처음 쓸 때 macOS가 "Synapse이(가) Terminal을(를)
제어하려고 합니다" 권한을 한 번 묻는다 — 허용하면 이후 다시 묻지 않는다.
(시스템 설정 → 개인정보 보호 및 보안 → 자동화 에서 변경 가능.)

동기화 기능은 `git`을 사용한다 — Xcode Command Line Tools가 설치되어 있으면 포함되어 있고, 없으면 처음 git 호출 시 macOS가 설치를 안내한다.

Windows는 아직 코드 서명이 없어 SmartScreen 경고가 뜰 수 있다. `추가 정보` → `실행`으로 열 수 있으며, Authenticode 서명은 후속 과제다(§8).

## 5. macOS 서명 + 공증 구성

### 무엇이 설정되어 있나

| 파일 | 역할 |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.macOS`에서 `hardenedRuntime` 활성화, `entitlements.plist` 지정 |
| `src-tauri/entitlements.plist` | Hardened Runtime 아래에서 앱이 실제로 필요한 권한만 명시 |
| `src-tauri/Info.plist` | `NSAppleEventsUsageDescription` (Tauri가 기본 Info.plist에 병합) |
| `.github/workflows/release-desktop.yml` | tauri-action에 서명·공증 secrets를 넘긴다 |
| `.github/workflows/ci.yml` | 서명까지만 드라이런한다 (공증은 PR마다 돌리기엔 느려서 제외) |

`signingIdentity`는 설정 파일에 넣지 않는다. 환경변수 `APPLE_SIGNING_IDENTITY`로
주입하므로, 인증서가 없는 로컬 개발 빌드는 종전대로 ad-hoc 서명으로 그냥 된다.

### entitlements를 함부로 줄이지 말 것

Hardened Runtime은 기본적으로 막는 게 많아서, 아래 항목은 각각 실제 코드 경로와 짝이다:

| 키 | 없으면 깨지는 것 |
|---|---|
| `cs.allow-jit` | WKWebView의 JS JIT — 앱 화면이 아예 안 뜬다 |
| `cs.disable-library-validation` | `synapse-mcp` 사이드카, `git`·`osascript` 실행 |
| `automation.apple-events` | 외부 터미널(Terminal·iTerm) 열기 (`external_terminal.rs`) |
| `network.client` | GitHub Device Flow 로그인, 동기화, 업데이터 |

`automation.apple-events`는 `Info.plist`의 `NSAppleEventsUsageDescription`과 **짝**이다.
둘 중 하나만 있으면 권한 프롬프트가 뜨지 않고 기능이 조용히 실패한다.

App Sandbox는 켜지 않는다. 사용자가 고른 임의 경로의 노트 폴더를 직접 읽고 쓰는
앱이라 샌드박스 모델과 맞지 않는다 (Developer ID 직접 배포는 샌드박스가 필수도 아니다).

### GitHub Secrets (1회 등록)

| Secret | 내용 |
|---|---|
| `APPLE_CERTIFICATE` | **Developer ID Application** .p12를 base64 인코딩한 값 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 내보내기 암호 |
| `APPLE_SIGNING_IDENTITY` | 예: `Developer ID Application: Hong Gildong (TEAMID)` |
| `APPLE_ID` | Apple 계정 이메일 (공증용) |
| `APPLE_PASSWORD` | 앱 암호(App-Specific Password) — 계정 비밀번호가 **아니다** |
| `APPLE_TEAM_ID` | 10자리 팀 ID (공증용) |

주의할 점:

- 인증서 종류가 중요하다. **`Developer ID Application`** 이어야 한다.
  `Apple Distribution` / `Apple Development`는 App Store·개발 전용이라
  DMG 직접 배포에 쓸 수 없다 (`security find-identity -v -p codesigning`으로 확인).
- .p12는 **개인 키를 포함해** 내보내야 한다. 키체인 접근에서 인증서를 펼쳐
  개인 키까지 함께 선택한 뒤 내보내기. 인증서만 내보내면 러너에서 서명이 실패한다.
- `APPLE_PASSWORD`는 https://appleid.apple.com → 로그인 및 보안 → 앱 암호 에서 만든다.
- 공증 3종(`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`)이 **모두** 있어야 공증이 돈다.
  하나라도 비면 서명만 되고 공증은 조용히 건너뛴다 — 그러면 사용자에게 여전히
  Gatekeeper 경고가 뜬다.

```bash
# .p12 base64 인코딩
base64 -i developer-id.p12 | pbcopy

# 팀 ID 확인 (인증서 이름의 괄호 안 10자리)
security find-identity -v -p codesigning
```

### 릴리스 후 검증

DMG를 받아서 확인한다:

```bash
# 공증 티켓이 앱에 staple 되었는지
xcrun stapler validate /Applications/Synapse.app

# Gatekeeper가 실제로 통과시키는지 (핵심 확인)
spctl -a -vvv -t install /Applications/Synapse.app
#   → "accepted / source=Notarized Developer ID" 가 나와야 한다

# 서명·entitlements 확인
codesign -dv --entitlements - /Applications/Synapse.app
```

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
