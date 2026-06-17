import { test, expect } from "@playwright/test";
import { openMockWorkspace, openDrawioFile, waitForViewerLoaded } from "./helpers";

// .drawio 뷰어의 배선 회귀.
//
// 파일을 열면 뷰어가 에러/플레이스홀더 없이 iframe 으로 떠야 한다(content →
// buildDrawioHtml → prepareHtmlView → iframe src). 픽셀 단위 다이어그램 렌더는
// 브라우저(mock) 모드의 sandbox+교차출처 제약으로 검증 불가다(helpers 주석 참고) —
// 임베드 렌더/핸드셰이크의 실질 회귀는 drawio-editor.spec.ts 가 잡는다.

test("뷰어가 에러 없이 로드된다", async ({ page }) => {
  await openMockWorkspace(page);
  await openDrawioFile(page);
  await waitForViewerLoaded(page);
  // 모드 토글(뷰어/편집)이 함께 떠 있어야 한다 — drawio 페인이 정상 마운트됐다는 신호.
  await expect(page.locator(".drawio-mode-toggle")).toBeVisible();
});
