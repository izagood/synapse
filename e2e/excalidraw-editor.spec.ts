import { test, expect } from "@playwright/test";
import { openMockWorkspace, openExcalidrawFile, waitForExcalidrawLoaded } from "./helpers";

// .excalidraw 에디터 회귀.
//
// Excalidraw 는 drawio 와 달리 iframe/postMessage 가 아니라 동일 출처 React 컴포넌트라
// e.source=null 류 핸드셰이크 버그는 없다. 대신 무거운 번들 + 손글씨 폰트 + 캔버스
// 초기화가 WebView 에서 깨지지 않는지가 관건이다. 배포 타깃 WebView 는 macOS=WKWebView
// 이고 webkit 프로젝트가 그에 가장 가까우므로, 이 스펙의 핵심 가치는 webkit 실행에 있다.
//
// 메뉴 라벨 검증은 로케일에 의존하므로 en-US 로 고정한다.
test.use({ locale: "en-US" });

test(".excalidraw 를 열면 캔버스가 에러 없이 뜬다", async ({ page }) => {
  test.slow(); // Excalidraw 번들 부팅 + 폰트 로드. 기본 타임아웃 3배.

  await openMockWorkspace(page);
  await openExcalidrawFile(page);

  // 번들/폰트/캔버스 초기화가 성공하면 캔버스가 뜬다. 실패하면(회귀) 에러
  // 플레이스홀더가 남거나 캔버스가 영영 안 떠 여기서 실패한다.
  await waitForExcalidrawLoaded(page);
});

test("메인메뉴에서 워크스페이스 모델과 충돌하는 항목이 제거됐다", async ({ page }) => {
  test.slow();

  await openMockWorkspace(page);
  await openExcalidrawFile(page);
  await waitForExcalidrawLoaded(page);

  // 메인메뉴(☰)를 연다.
  await page.locator(".main-menu-trigger").click();
  const menu = page.locator(".dropdown-menu-container");
  await expect(menu).toBeVisible();

  // 우리가 의도적으로 뺀 항목들이 노출되면 안 된다(UIOptions/MainMenu 회귀).
  await expect(menu).not.toContainText("Live collaboration");
  await expect(menu).not.toContainText("Open");
  await expect(menu).not.toContainText("Save to");

  // 유지하기로 한 "이미지로 내보내기"는 남아 있어야 한다(네이티브 export 경로).
  await expect(menu.locator(".dropdown-menu-item")).not.toHaveCount(0);
});
