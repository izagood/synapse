// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./extensions";
import { lineBlocks, resolveLineBlock } from "./lineNumberGutter";

function makeEditor(markdown: string): Editor {
  return new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
}

describe("lineBlocks", () => {
  it("최상위 블록마다 1-기반 번호를 순서대로 매긴다", () => {
    const editor = makeEditor("# 제목\n\n첫 문단\n\n둘째 문단");
    const blocks = lineBlocks(editor.state.doc);
    expect(blocks.map((b) => b.line)).toEqual([1, 2, 3]);
    editor.destroy();
  });

  it("콘텐츠 블록은 내부(offset+1), 리프 블록(수평선)은 앞(offset)에 위젯을 둔다", () => {
    const editor = makeEditor("문단\n\n---\n\n다음");
    const blocks = lineBlocks(editor.state.doc);
    // 문단, 수평선, 문단 → 3줄
    expect(blocks.map((b) => b.line)).toEqual([1, 2, 3]);
    expect(blocks[0].leaf).toBe(false);
    expect(blocks[1].leaf).toBe(true); // horizontalRule
    expect(blocks[2].leaf).toBe(false);
    // 콘텐츠 블록은 노드 시작(offset)보다 1 큰 안쪽, 리프는 노드 시작 그대로
    const offsets: number[] = [];
    editor.state.doc.forEach((_node, offset) => offsets.push(offset));
    expect(blocks[0].pos).toBe(offsets[0] + 1);
    expect(blocks[1].pos).toBe(offsets[1]);
    expect(blocks[2].pos).toBe(offsets[2] + 1);
    editor.destroy();
  });

  it("빈 문서도 한 블록(빈 문단)으로 한 줄을 만든다", () => {
    const editor = makeEditor("");
    expect(lineBlocks(editor.state.doc).length).toBeGreaterThanOrEqual(1);
    editor.destroy();
  });
});

describe("줄 번호 위젯 렌더링", () => {
  it("블록 수만큼 .ln-num 위젯을 1..N 텍스트로 그린다", () => {
    const editor = makeEditor("# 제목\n\n문단\n\n- 항목");
    const nums = editor.view.dom.querySelectorAll(".ln-num");
    expect(nums.length).toBe(3);
    expect(Array.from(nums).map((n) => n.textContent)).toEqual(["1", "2", "3"]);
    editor.destroy();
  });
});

describe("resolveLineBlock", () => {
  it("블록 내부에 박힌 위젯은 .tiptap 직속 조상 블록을 가리킨다", () => {
    document.body.innerHTML = `
      <div class="tiptap">
        <h1><span class="ln-num">1</span>제목</h1>
        <p><span class="ln-num">2</span>본문</p>
      </div>`;
    const span = document.querySelector("h1 .ln-num") as HTMLElement;
    const block = resolveLineBlock(span);
    expect(block?.tagName).toBe("H1");
  });

  it("리프 블록 앞(.tiptap 직속)에 놓인 위젯은 다음 형제 블록을 가리킨다", () => {
    document.body.innerHTML = `
      <div class="tiptap">
        <span class="ln-num">1</span>
        <hr>
        <p>본문</p>
      </div>`;
    const span = document.querySelector(".tiptap > .ln-num") as HTMLElement;
    const block = resolveLineBlock(span);
    expect(block?.tagName).toBe("HR");
  });

  it(".tiptap 밖이면 null", () => {
    document.body.innerHTML = `<div><span class="ln-num">1</span></div>`;
    const span = document.querySelector(".ln-num") as HTMLElement;
    expect(resolveLineBlock(span)).toBeNull();
  });
});
