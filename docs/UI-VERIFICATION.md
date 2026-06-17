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
npm run e2e:update     # 시각 스냅샷 기준선 (재)생성
npm run e2e:report     # 마지막 리포트 열기
```

스펙(`e2e/`):

- `drawio-viewer.spec.ts` — 뷰어가 다이어그램을 그리는지(도형 라벨 가시) + 라이트/다크
  시각 스냅샷(도형 가시성 회귀 감시)
- `drawio-editor.spec.ts` — 편집 모드로 전환 시 시드 다이어그램이 로드되는지
  (WKWebView `e.source==null` 핸드셰이크 회귀 가드 — **webkit 실행에 가치가 있다**)

### 최초 셋업 (시스템 의존성)

브라우저 바이너리는 `npx playwright install chromium webkit` 로 받지만, 리눅스에선
구동에 시스템 라이브러리가 필요하다. **한 번** 실행한다:

```bash
sudo npx playwright install-deps     # 또는: sudo npx playwright install --with-deps
```

그 뒤 시각 스냅샷 기준선을 생성·커밋한다(엔진/OS 별로
`e2e/__screenshots__/<project>/` 에 분리 저장):

```bash
npm run e2e:update
```

## 계층 3 — CI (`.github/workflows/e2e.yml`)

PR 마다 실제 브라우저로 E2E 를 돌려 회귀를 머지 전에 잡는다(ci.yml 과 같은 철학으로
PR 에서만 실행).

- `e2e-linux` (ubuntu): chromium + webkit. `npx playwright install --with-deps` 로
  시스템 의존성까지 설치한다.
- `e2e-macos` (macos-14): webkit 전용 — WKWebView 에 가장 가까운 엔진으로, macOS
  배포에서만 나던 핸드셰이크 회귀를 잡는 마지막 관문.

**기능 회귀(렌더/핸드셰이크) 스펙은 기준선이 필요 없어 곧장 게이트**다. 시각 스냅샷은
기준선이 커밋되기 전까진 `continue-on-error` 로 정보용이다.

### 시각 스냅샷 기준선 부트스트랩

기준선은 OS/엔진별로 픽셀이 다르다. 로컬에 해당 OS 가 없으면 CI 에서 생성한다:

1. Actions 탭 → **E2E** → **Run workflow**(`workflow_dispatch`) 실행 →
   `baselines` 잡이 ubuntu/macOS 각각에서 스냅샷을 만들어 아티팩트
   (`screenshots-<os>`)로 올린다.
2. 아티팩트를 받아 `e2e/__screenshots__/` 에 풀고 커밋한다.
3. 기준선이 생기면 `e2e.yml` 의 "시각 스냅샷" 스텝에서 `continue-on-error: true` 를
   지워 게이트로 승격한다.

로컬에 해당 OS 가 있으면 그냥 `npm run e2e:update` 로 생성·커밋하면 된다.
