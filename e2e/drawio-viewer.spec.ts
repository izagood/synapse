import { test, expect } from "@playwright/test";
import { openMockWorkspace, openDrawioFile, waitForViewerRendered } from "./helpers";

// .drawio 뷰어의 렌더 정합성 + 시각 회귀.
//
// jsdom 으로는 못 잡던 영역이다: 번들된 drawio 런타임이 진짜 iframe 안에서
// 다이어그램을 그리는지, 다크 앱 테마에서도 도형이 보이는지(검정-위-검정 회귀)를
// 실제 엔진(chromium/webkit)에서 검증한다.

test.beforeEach(async ({ page }) => {
  await openMockWorkspace(page);
  await openDrawioFile(page);
});

test("뷰어가 다이어그램을 렌더한다", async ({ page }) => {
  const frame = await waitForViewerRendered(page);
  // 시드 다이어그램의 도형 라벨이 보여야 한다 — 핸드셰이크/파싱이 정상이라는 신호.
  await expect(frame.getByText("시작")).toBeVisible();
  await expect(frame.getByText("끝")).toBeVisible();
});

// 시각 스냅샷. 기준선은 최초 1회 `npm run e2e:update` 로 생성해 커밋한다
// (엔진/OS 별로 e2e/__screenshots__/<project>/ 에 분리 저장된다).
test("뷰어 시각 스냅샷 — 라이트", async ({ page }) => {
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await waitForViewerRendered(page);
  await expect(page.locator("iframe.drawio-viewer")).toHaveScreenshot("viewer-light.png", {
    maxDiffPixelRatio: 0.02,
  });
});

test("뷰어 시각 스냅샷 — 다크 (도형 가시성 회귀 감시)", async ({ page }) => {
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await waitForViewerRendered(page);
  await expect(page.locator("iframe.drawio-viewer")).toHaveScreenshot("viewer-dark.png", {
    maxDiffPixelRatio: 0.02,
  });
});
