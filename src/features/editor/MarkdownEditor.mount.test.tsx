// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React from "react";
import ReactDOM from "react-dom/client";
import { useWorkspace } from "../../stores/workspace";
import { MarkdownEditor } from "./MarkdownEditor";

// 실기기 회귀(v0.5.42 앱 먹통): @tiptap/extensions의 Placeholder 내장 viewport
// 플러그인은 에디터 뷰 생성 "도중" 동기적으로 setMeta 트랜잭션을 dispatch한다
// (createViewportPluginView → computeAndDispatch — 초기 상태 {null,null}과 항상
// 달라 무조건 dispatch). 이 트랜잭션이 onUpdate를 컴포넌트 함수 실행 중간
// (useEditor 내부)에 발화시키므로, onUpdate가 useEditor 호출보다 아래에 선언된
// 변수를 참조하면 TDZ ReferenceError로 React 트리 전체가 unmount된다(빈 화면).
//
// jsdom에는 elementFromPoint가 없어 이 경로가 평소 테스트에서 실행되지 못했다
// (다른 에디터 테스트들이 withPlaceholder:false로 도는 이유). 여기서는 stub을
// 채워 실제 viewport 플러그인이 실제 dispatch까지 진행하게 해 그대로 재현한다.
const PATH = "/mock/notes/README.md";

describe("MarkdownEditor 마운트: 생성 중 동기 트랜잭션에도 크래시하지 않는다", () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root | undefined;
  const windowErrors: unknown[] = [];
  const onWindowError = (e: ErrorEvent) => {
    e.preventDefault(); // React 18의 rethrow가 테스트 러너를 죽이지 않게
    windowErrors.push(e.error ?? e.message);
  };

  beforeEach(() => {
    if (typeof document.elementFromPoint !== "function") {
      document.elementFromPoint = () => null;
    }
    windowErrors.length = 0;
    window.addEventListener("error", onWindowError);
    container = document.createElement("div");
    document.body.appendChild(container);
    useWorkspace.setState({
      docs: {
        [PATH]: {
          // 리스트로 "끝나는" 문서 — TrailingNode의 appendTransaction이 끝에 빈
          // 문단을 붙이는 doc 변경을 유발해, viewport dispatch가 update emit까지
          // 이어지는 실기기 조건(2026-08-24 노트와 동일 구조)을 재현한다.
          content: "# 제목\n\n- 항목 하나\n- 항목 둘",
          savedContent: "# 제목\n\n- 항목 하나\n- 항목 둘",
          externalRev: 0,
          externalStale: false,
          loading: false,
          error: null,
        },
      },
    });
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    window.removeEventListener("error", onWindowError);
    useWorkspace.setState({ docs: {} });
  });

  it("Placeholder viewport 플러그인의 뷰 생성 직후 dispatch에도 에디터가 살아서 렌더된다", async () => {
    root = ReactDOM.createRoot(container);
    root.render(React.createElement(MarkdownEditor, { path: PATH }));
    // 마운트·effect 플러시 대기
    await new Promise((r) => setTimeout(r, 50));

    expect(
      windowErrors,
      `마운트 중 에러: ${windowErrors.map(String).join("\n")}`,
    ).toEqual([]);
    // React 트리가 unmount되지 않고 ProseMirror 에디터가 실제로 렌더됐는지
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
  });
});
