import { expect, type Page, type FrameLocator } from "@playwright/test";

// mock 워크스페이스를 열고 파일 트리가 보일 때까지 기다린다. StartScreen 의
// 기본 버튼(.primary-btn)은 mock 의 pickFolder() 가 MOCK_ROOT 를 돌려줘 곧장
// 워크스페이스를 연다. (언어와 무관하게 클래스 셀렉터로 누른다.)
export async function openMockWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".primary-btn").first().click();
  await expect(page.locator(".tree-row").first()).toBeVisible();
}

// 트리에서 디렉터리를 펼치고 .drawio 파일을 연다.
export async function openDrawioFile(page: Page): Promise<void> {
  await page.locator(".tree-row.tree-dir", { hasText: "diagrams" }).click();
  await page.locator(".tree-row.tree-file", { hasText: "flow.drawio" }).click();
}

// 뷰어 iframe 안에서 drawio 런타임이 다이어그램(svg)을 그릴 때까지 기다린다.
export async function waitForViewerRendered(page: Page): Promise<FrameLocator> {
  const frame = page.frameLocator("iframe.drawio-viewer");
  await expect(frame.locator("svg")).toBeVisible({ timeout: 15_000 });
  return frame;
}
