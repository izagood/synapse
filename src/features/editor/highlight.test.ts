// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, lowlight } from "./extensions";

// CodeBlockLowlight가 실제로 문법 하이라이트 데코레이션(hljs-* span)을
// 붙이는지 검증한다. 라운드트립 테스트는 md 보존만 보므로 여기서 렌더를 본다.
function mountEditor(markdown: string): { editor: Editor; el: HTMLElement } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  return { editor, el };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("code block syntax highlighting (CodeBlockLowlight)", () => {
  it("registers common languages we care about", () => {
    for (const lang of ["rust", "typescript", "javascript", "python", "bash", "json"]) {
      expect(lowlight.registered(lang), `${lang} should be registered`).toBe(true);
    }
  });

  it("renders hljs token spans for a rust code block", () => {
    const { editor, el } = mountEditor(
      '```rust\nfn main() {\n    // 주석\n    println!("{}", 42);\n}\n```',
    );
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    const pre = el.querySelector("pre");
    expect(pre).not.toBeNull();
    // 키워드(fn)·주석·문자열이 각각 토큰 클래스로 감싸져야 한다
    expect(pre!.querySelector(".hljs-keyword")?.textContent).toBe("fn");
    expect(pre!.querySelector(".hljs-comment")?.textContent).toContain("주석");
    expect(pre!.querySelector(".hljs-string")?.textContent).toContain("{}");
  });

  it("renders plain text without crashing for unknown languages", () => {
    const { editor, el } = mountEditor("```nosuchlang\nhello world\n```");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    const code = el.querySelector("pre code");
    expect(code?.textContent).toContain("hello world");
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBe(0);
  });
});
