# UI 검증 환경

마크다운 노트 앱 본체와 달리, 임베드 뷰어/에디터(drawio, HTML, Excalidraw, PDF)는
**iframe + postMessage + 실제 렌더링**에 의존한다. 이 영역의 버그는 `vitest + jsdom`
으로 원천적으로 못 잡는다 — jsdom 은 iframe 스크립트를 실행하지 않고, 교차 프레임
postMessage 도, 픽셀도 없기 때문이다.

대표 사례가 drawio 다. 같은 부류의 버그가 반복됐다:

- macOS WKWebView 가 `postMessage` 의 `e.source` 를 `null` 로 줘서 embed 핸드셰이크의
  `init` 이 버려지고 에디터가 빈 화면으로 멈춤 — **릴리즈에서만** 재현
- 다크 테마에서 다이어그램이 검정-위-검정으로 안 보임 — **시각** 회귀
- 로딩 중 빈 시드가 autosave 되며 파일을 덮어씀 — iframe ↔ 스토어 **타이밍**

이 문서의 환경은 그런 버그를 **개발 중에 눈으로 확인하고, 회귀로 고정**하기 위한 것이다.

## 토대: 브라우저 모드 = mock 백엔드

`src/ipc/ipc.ts` 는 `__TAURI_INTERNALS__` 가 없으면(=일반 브라우저) 자동으로
인메모리 mock 백엔드(`src/ipc/mock.ts`)로 폴백한다. 즉 **브라우저로 앱을 열면
mock 워크스페이스(`/mock/notes`) 위에서 앱 전체가 그대로 돈다.** 두 도구 모두 이
토대를 그대로 쓴다 — 별도 백엔드/모킹이 필요 없다.

## 계층 1 — Ladle 컴포넌트 워크벤치 (빠른 inner loop)

뷰어 컴포넌트를 라이트/다크·픽스처와 함께 격리 렌더한다. "보면서 개발"용.

```bash
npm run ladle          # 개발 서버 (http://localhost:61000)
npm run ladle:build    # 정적 빌드 (CI 컴파일 점검용)
```

- 스토리: `src/**/*.stories.tsx` (예: `DrawioViewer.stories.tsx`, `HtmlViewer.stories.tsx`)
- 테마 토글: `src/ladle/ThemeFrame.tsx` 가 `data-theme` 를 입힌다(앱과 동일 방식)
- 공유 픽스처: `src/features/drawio-viewer/fixtures.ts` (mock 시드도 같은 값을 씀)

## 계층 2 — Playwright E2E + 시각 회귀

vite dev(포트 1420) 위의 **실제 앱**을 진짜 브라우저로 구동한다. 엔진을 **chromium
과 webkit 둘 다** 돌리는 게 핵심이다 — 배포 타깃 WebView 가 macOS=WKWebView 인데,
Playwright 의 webkit 빌드가 Linux/CI 에서 그에 가장 가까운 엔진이다.

```bash
npm run e2e            # 전체 (chromium + webkit)
npm run e2e -- --project=webkit          # WKWebView 계열만
npm run e2e:ui         # UI 모드(디버깅)
npm run e2e:report     # 마지막 리포트 열기
```

스펙(`e2e/`):

- `drawio-editor.spec.ts` — **핵심 가드.** 편집 모드 전환 시 시드 다이어그램이
  실제로 로드되는지(도형 라벨 가시) 본다. 에디터 iframe 은 번들된 drawio 앱을
  동일 출처(`vendor/drawio-app/`)로 띄우므로 브라우저 모드에서도 앱이 부팅하고
  embed 핸드셰이크가 돈다 — WKWebView `e.source==null` 로 init 이 버려지면(회귀)
  영영 빈 채라 여기서 실패한다. **webkit 실행에 가치가 있다.**
- `drawio-viewer.spec.ts` — 뷰어 배선(파일→HTML→iframe)이 에러 없이 마운트되는지.

#### 알려진 한계: 뷰어 픽셀 렌더는 mock 모드에서 검증 못 함

`.drawio` **뷰어**(에디터 아님)는 `sandbox="allow-scripts"` iframe(불투명 출처)에
번들 뷰어 런타임을 **부모 출처의 blob URL 스크립트**로 주입한다. 브라우저(mock)
모드에선 이 교차 출처 스크립트 로드가 막혀 내부 SVG 가 그려지지 않는다. 실제 Tauri
WebView 는 asset 프로토콜(동일 출처)이라 정상 렌더된다. 그래서 뷰어의 다크모드
시각 회귀 등 **픽셀 단위 검증은 실제 WebView(향후 tauri-driver) 영역**으로 남기고,
임베드 렌더/핸드셰이크의 실질 회귀는 (동일 출처라 실제로 렌더되는) 에디터 스펙으로
잡는다. HTML 뷰어 등 **외부 스크립트가 필요 없는** 임베드는 mock 모드에서도 그대로
렌더되므로 Ladle 워크벤치(계층 1)에서 시각 확인이 가능하다.

### 최초 셋업 (시스템 의존성)

브라우저 바이너리는 `npx playwright install chromium webkit` 로 받지만, 리눅스에선
구동에 시스템 라이브러리가 필요하다. **한 번** 실행한다:

```bash
sudo npx playwright install-deps     # 또는: sudo npx playwright install --with-deps
```

## 계층 3 — CI (`.github/workflows/e2e.yml`)

PR 마다 실제 브라우저로 E2E 를 돌려 회귀를 머지 전에 잡는다(ci.yml 과 같은 철학으로
PR 에서만 실행).

- `e2e-linux` (ubuntu): chromium + webkit. `npx playwright install --with-deps` 로
  시스템 의존성까지 설치한다.
- `e2e-macos` (macos-14): webkit 전용 — WKWebView 에 가장 가까운 엔진으로, macOS
  배포에서만 나던 핸드셰이크 회귀를 잡는 마지막 관문.

## 다음 단계 (선택)

- **tauri-driver + WebDriver**: 실제 Tauri WebView(Linux=WebKitGTK, Windows=WebView2)
  를 구동해 뷰어 픽셀 렌더·다크모드 시각 회귀까지 잡는다 — mock 모드의 sandbox 한계를
  넘는 유일한 경로. (WKWebView 는 WebDriver 미지원이라 macOS 는 여전히 webkit 근사로 본다.)
