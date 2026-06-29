import { test, expect } from "@playwright/test";
import { openMockWorkspace, openDrawioFile } from "./helpers";

// .drawio 에디터 embed 핸드셰이크 회귀.
//
// 이게 가장 아팠던 버그다: macOS WKWebView 가 postMessage 의 e.source 를 null 로
// 줘서 init 이 버려지고, 에디터가 빈 화면으로 멈췄다. 재설계 후엔 모드 전환 없이
// 파일을 열면 곧바로 에디터가 뜨므로, "파일을 열면 시드 다이어그램이 실제로
// 뜨는가"를 본다. webkit 프로젝트가 WKWebView 에 가장 가까운 엔진이라 이 스펙의
// 핵심 가치는 webkit 실행에 있다(chromium 은 교차 확인용).
//
// 번들된 drawio 앱 전체가 부팅하므로 느리다 — 넉넉한 타임아웃을 준다.
test("파일을 열면 곧바로 에디터에 시드 다이어그램이 로드된다", async ({ page }) => {
  test.slow(); // drawio 앱 부팅 + 핸드셰이크. 기본 타임아웃 3배.

  await openMockWorkspace(page);
  await openDrawioFile(page);

  const editor = page.frameLocator("iframe.drawio-editor");
  // 모드 전환 없이 곧바로 에디터가 뜨고, 핸드셰이크가 성사돼 host 가 보낸
  // load(시드 XML)가 반영되면 캔버스에 시드 도형이 나타난다. init 이 버려지면
  // (회귀) 영영 빈 채라 여기서 실패한다.
  await expect(editor.getByText("시작")).toBeVisible({ timeout: 30_000 });
  await expect(editor.getByText("끝")).toBeVisible();
});
