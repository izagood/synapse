// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";

// v0.5.42 앱 먹통 회귀의 2차 방어선: 렌더 중 동기 throw가 나면 React 18은
// ErrorBoundary가 없을 때 root 전체를 unmount한다 — 사용자에게는 아무 정보 없는
// 빈 화면. 경계가 있으면 에러 화면(메시지 + 다시 시작)으로 대체된다.

function Bomb(): React.ReactElement {
  throw new Error("render-crash-test");
}

describe("ErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root | undefined;
  const onWindowError = (e: ErrorEvent) => e.preventDefault(); // React rethrow 흡수

  beforeEach(() => {
    window.addEventListener("error", onWindowError);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    window.removeEventListener("error", onWindowError);
  });

  it("정상 자식은 그대로 렌더한다", async () => {
    root = ReactDOM.createRoot(container);
    root.render(
      React.createElement(ErrorBoundary, null, React.createElement("div", null, "정상 콘텐츠")),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toContain("정상 콘텐츠");
  });

  it("자식이 렌더 중 throw하면 빈 화면 대신 에러 화면을 보여준다", async () => {
    root = ReactDOM.createRoot(container);
    root.render(React.createElement(ErrorBoundary, null, React.createElement(Bomb)));
    await new Promise((r) => setTimeout(r, 20));

    // 빈 화면이 아니어야 한다
    expect(container.innerHTML.length).toBeGreaterThan(0);
    // 원인 파악에 필요한 에러 메시지와 복구 수단(다시 시작)이 보인다
    expect(container.textContent).toContain("render-crash-test");
    expect(container.querySelector("button")).not.toBeNull();
  });
});
