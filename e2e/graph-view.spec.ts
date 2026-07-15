import { expect, test } from "@playwright/test";
import { openMockWorkspace } from "./helpers";

// 그래프 뷰 회귀 테스트.
//
// 노드 클릭 → 노트 열기는 포인터 캡처와 얽혀 있어 jsdom 으로는 못 잡는다:
// pointerdown 에서 svg 가 포인터를 캡처하면 click 이 svg 로 재타게팅돼
// 노드의 onClick 이 실행되지 않는 버그가 있었다 (실브라우저에서만 재현).
test.describe("graph view", () => {
  async function openGraph(page: import("@playwright/test").Page) {
    // ActivityBar 의 그래프 버튼 (제목은 로케일 의존 — 아이콘 순서로 특정)
    await page.keyboard.press("ControlOrMeta+Shift+G");
    await expect(page.locator(".graph-canvas")).toBeVisible();
  }

  test("노드를 클릭하면 해당 노트가 탭으로 열리고 모달이 닫힌다", async ({
    page,
  }) => {
    await openMockWorkspace(page);
    await openGraph(page);

    // README.md 노드를 클릭한다. 라벨은 숨겨질 수 있으니 <title>로 찾는다.
    const node = page
      .locator(".graph-node")
      .filter({ has: page.locator("title", { hasText: "README.md" }) });
    await node.click();

    await expect(page.locator(".graph-canvas")).toHaveCount(0);
    await expect(
      page.locator(".tab", { hasText: "README.md" }),
    ).toBeVisible();
  });

  test("드래그 팬 후 놓아도 노트가 열리지 않는다", async ({ page }) => {
    await openMockWorkspace(page);
    await openGraph(page);

    const canvas = page.locator(".graph-canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, {
      steps: 8,
    });
    await page.mouse.up();

    // 팬으로 취급 — 모달은 그대로 열려 있어야 한다.
    await expect(canvas).toBeVisible();
  });

  test("휠 스크롤 연타에도 줌이 폭주하지 않는다", async ({ page }) => {
    await openMockWorkspace(page);
    await openGraph(page);

    const canvas = page.locator(".graph-canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 트랙패드처럼 작은 델타 10회 — 예전 고정 15% 스텝이면 4배로 튄다.
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -3);
    }
    const transform = await canvas
      .locator("g")
      .first()
      .getAttribute("transform");
    const scale = Number(/scale\(([\d.]+)\)/.exec(transform ?? "")?.[1]);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThan(1.2);
  });
});
