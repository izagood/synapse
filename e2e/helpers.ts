import { expect, type Page } from "@playwright/test";

// mock 워크스페이스를 열고 파일 트리가 보일 때까지 기다린다. StartScreen 의
// 기본 버튼(.start-action-primary)은 mock 의 pickFolder() 가 MOCK_ROOT 를 돌려줘
// 곧장 워크스페이스를 연다. (언어와 무관하게 클래스 셀렉터로 누른다.)
export async function openMockWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".start-action-primary").first().click();
  await expect(page.locator(".tree-row").first()).toBeVisible();
}

// 트리에서 디렉터리를 펼치고 .drawio 파일을 연다.
export async function openDrawioFile(page: Page): Promise<void> {
  await page.locator(".tree-row.tree-dir", { hasText: "diagrams" }).click();
  await page.locator(".tree-row.tree-file", { hasText: "flow.drawio" }).click();
}

// 트리에서 디렉터리를 펼치고 .excalidraw 파일을 연다.
export async function openExcalidrawFile(page: Page): Promise<void> {
  await page.locator(".tree-row.tree-dir", { hasText: "drawings" }).click();
  await page.locator(".tree-row.tree-file", { hasText: "sketch.excalidraw" }).click();
}

// Excalidraw 번들이 마운트돼 캔버스가 떴는지 확인한다. drawio 와 달리 동일 출처
// React 컴포넌트라 캔버스가 앱 안에서 직접 그려진다 — webkit(WKWebView 근사)에서
// 번들/폰트/캔버스 초기화가 깨지지 않는지를 잡는 게 이 검증의 핵심이다.
export async function waitForExcalidrawLoaded(page: Page): Promise<void> {
  await expect(page.locator("canvas.excalidraw__canvas").first()).toBeVisible({
    timeout: 30_000,
  });
  // 에러/로딩 플레이스홀더가 남아 있으면 안 된다.
  await expect(page.locator(".preview-placeholder")).toHaveCount(0);
}
