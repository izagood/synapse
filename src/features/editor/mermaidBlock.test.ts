// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";

// 실제 mermaid 렌더링은 jsdom에서 동작하지 않으므로(getBBox 등 필요) 모듈을 모킹해
// NodeView가 결과를 어떻게 DOM에 반영하는지만 결정적으로 검증한다.
// isMermaidLanguage는 실제 구현을 그대로 쓴다.
vi.mock("./mermaid", async () => {
  const actual = await vi.importActual<typeof import("./mermaid")>("./mermaid");
  return {
    ...actual,
    renderMermaid: vi.fn(async (source: string) => {
      if (source.includes("BROKEN")) return { ok: false as const, error: "parse error" };
      return { ok: true as const, svg: `<svg data-mermaid>${source.trim()}</svg>` };
    }),
  };
});

import { editorExtensions } from "./extensions";

function mount(markdown: string): { editor: Editor; el: HTMLElement } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: editorExtensions({ withPlaceholder: false, mermaidErrorLabel: "오류" }),
    content: markdown,
  });
  return { editor, el };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.clearAllMocks();
});

describe("mermaid code block NodeView", () => {
  it("renders a mermaid block as a diagram preview while keeping the editable source", async () => {
    const { editor, el } = mount("```mermaid\ngraph TD\n  A --> B\n```");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };
    await tick();

    const block = el.querySelector(".mermaid-block");
    expect(block).not.toBeNull();
    // 미리보기에 렌더된 SVG가 들어가야 한다
    const svg = block!.querySelector(".mermaid-preview svg");
    expect(svg).not.toBeNull();
    expect(svg!.textContent).toContain("graph TD");
    // 편집 가능한 소스(code)도 그대로 남아 있어야 한다
    const code = block!.querySelector("pre code");
    expect(code?.textContent).toContain("graph TD");
    expect(code?.textContent).toContain("A --> B");
  });

  it("shows an error label instead of crashing when the diagram fails to parse", async () => {
    const { editor, el } = mount("```mermaid\nBROKEN\n```");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };
    await tick();

    const preview = el.querySelector(".mermaid-preview");
    expect(preview).not.toBeNull();
    expect(preview!.classList.contains("mermaid-error")).toBe(true);
    expect(preview!.textContent).toContain("오류");
    expect(preview!.textContent).toContain("parse error");
  });

  it("leaves non-mermaid code blocks untouched (no diagram preview)", async () => {
    const { editor, el } = mount("```ts\nconst x = 1;\n```");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };
    await tick();

    expect(el.querySelector(".mermaid-block")).toBeNull();
    expect(el.querySelector(".mermaid-preview")).toBeNull();
    // 일반 코드 블록은 정상 표시
    expect(el.querySelector("pre code")?.textContent).toContain("const x = 1;");
  });
});
