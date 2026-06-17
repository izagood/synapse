import { defineConfig, devices } from "@playwright/test";

// E2E 환경.
//
// 대상은 vite dev 서버(포트 1420) 위에서 도는 실제 프론트엔드다. Tauri 밖이라
// IPC 는 자동으로 인메모리 mock 백엔드(src/ipc/mock.ts)로 폴백하므로, 별도
// 백엔드 없이 앱 전체를 진짜 브라우저에서 구동한다.
//
// 엔진을 chromium 과 webkit 둘 다 돌리는 게 핵심이다. 배포 타깃의 WebView 는
// macOS=WKWebView 인데, Playwright 의 webkit 빌드가 Linux/CI 에서 그에 가장 가까운
// 엔진이다 — drawio embed 핸드셰이크 같은 WebView 의존 버그를 릴리즈 전에 잡는다.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
