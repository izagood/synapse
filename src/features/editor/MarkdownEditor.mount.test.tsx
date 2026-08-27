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

type MountedEditor = {
  commands: { insertContentAt(pos: number, content: string): boolean };
  state: { doc: { content: { size: number } } };
};

// 렌더된 트리에서 tiptap editor 인스턴스를 꺼낸다.
// jsdom에는 ProseMirror가 입력을 감지하는 데 필요한 것들이 없어 키 이벤트로는
// 편집을 일으킬 수 없다. EditorContent가 editor를 props로 받으므로 React
// fiber를 타고 올라가 인스턴스를 얻는다(테스트 전용 우회 — 앱 코드에 테스트용
// 훅을 남기지 않기 위한 선택).
function getMountedEditor(container: HTMLElement): MountedEditor {
  const host = container.querySelector(".editor-content");
  if (!host) throw new Error("EditorContent가 렌더되지 않았다");
  const fiberKey = Object.keys(host).find((k) => k.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber를 찾지 못했다");
  let fiber = (host as unknown as Record<string, { memoizedProps?: { editor?: MountedEditor }; return?: unknown }>)[
    fiberKey
  ];
  for (let i = 0; i < 12 && fiber; i++) {
    const editor = fiber.memoizedProps?.editor;
    if (editor?.commands) return editor;
    fiber = fiber.return as typeof fiber;
  }
  throw new Error("editor 인스턴스를 찾지 못했다");
}

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
    // jsdom에는 레이아웃이 없어 Range/Element의 사각형 API가 비어 있다.
    // Placeholder의 viewport 플러그인이 실제 편집 트랜잭션에서 이걸 호출하므로
    // 빈 구현을 채워 둔다(값은 쓰이지 않고 존재 여부만 문제가 된다).
    if (typeof Range.prototype.getClientRects !== "function") {
      Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as never;
    }
    if (typeof Range.prototype.getBoundingClientRect !== "function") {
      Range.prototype.getBoundingClientRect = () => new DOMRect();
    }
    if (typeof Element.prototype.getClientRects !== "function") {
      Element.prototype.getClientRects = () => Object.assign([], { item: () => null }) as never;
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

  // F5: 외부 리로드가 아직 화면에 적용되지 않은 사이에 사용자가 입력하면,
  // 에디터는 외부 적용을 포기하고 배지로 강등하면서 savedContent를 자기가 보고
  // 있던 기준으로 되돌려야 한다. 되돌리지 않으면 base == disk가 되어 백엔드
  // 3-way가 실행되지 않고 외부 변경이 조용히 덮어써진다.
  //
  // store 단위 테스트(workspace.test.ts)와 달리 여기서는 실제 onUpdate 가드가
  // 그 액션을 부르는지를 확인한다 — 컴포넌트가 실제로 태우는 경로여야 의미가 있다.
  it("F5: 적용 전 외부 리로드 상태에서 입력하면 병합 기준을 되돌리고 배지로 강등한다", async () => {
    const editorBase = "# 제목\n\n- 항목 하나\n- 항목 둘";
    root = ReactDOM.createRoot(container);
    root.render(React.createElement(MarkdownEditor, { path: PATH }));
    await new Promise((r) => setTimeout(r, 50));

    // sync가 외부 변경을 반영한 상태를 만든다: content/savedContent가 둘 다
    // 새 디스크 내용으로 전진하고 externalRev가 올라간다(reloadAfterSync와 동일).
    // 단 에디터가 아직 setContent로 적용하지 못한 시점을 흉내 내려면, 적용
    // effect가 도는 것보다 먼저 사용자의 입력이 들어와야 한다.
    const external = `${editorBase}\n- 외부 항목`;
    useWorkspace.setState((s) => ({
      docs: {
        ...s.docs,
        [PATH]: {
          ...s.docs[PATH],
          content: external,
          savedContent: external,
          externalRev: s.docs[PATH].externalRev + 1,
        },
      },
    }));

    // effect가 적용하기 전에 사용자가 타이핑한다.
    // jsdom에서는 ProseMirror의 DOM 변경 감지(MutationObserver)가 돌지 않아
    // 키 입력을 흉내 낼 수 없으므로, 렌더된 EditorContent에서 실제 editor
    // 인스턴스를 얻어 명령으로 편집한다 — onUpdate는 그대로 발화한다.
    const editor = getMountedEditor(container);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "타");
    await new Promise((r) => setTimeout(r, 50));

    const doc = useWorkspace.getState().docs[PATH];
    // 배지가 서고, 병합 기준이 에디터가 보던 내용으로 되돌려져야 한다.
    // 되돌리지 않으면 base == disk가 되어 저장 시 3-way가 생략된다(F5).
    expect(doc.externalStale).toBe(true);
    expect(doc.savedContent).toBe(editorBase);
    // 사용자의 타이핑은 살아 있어야 한다(입력을 무시하던 옛 동작 방지).
    expect(doc.content).toContain("타");
    // 에디터도 살아 있어야 한다(TDZ 회귀 방지와 같은 계약).
    expect(windowErrors, `에러: ${windowErrors.map(String).join("\n")}`).toEqual([]);
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
  });
});
