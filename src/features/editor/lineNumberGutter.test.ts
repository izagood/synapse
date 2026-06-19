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

describe("현재 줄(커서) 강조", () => {
  // 현재 줄 강조는 node decoration으로 구현한다(직접 DOM 토글 금지 — PM 재조정과
  // 충돌해 무한 redraw로 앱이 멈춘다). decoration이라 커서가 놓인 블록에만 .ln-active가
  // 그려지고, 선택이 바뀌면 한 곳만 따라 옮겨가야 한다.
  it("커서가 놓인 블록에만 .ln-active가 붙고, 이동하면 따라온다", () => {
    const editor = makeEditor("# 제목\n\n첫 문단\n\n둘째 문단");
    const tiptap = editor.view.dom;
    // 둘째 문단 끝으로 커서 이동
    editor.commands.focus();
    editor.commands.setTextSelection(editor.state.doc.content.size);
    const active = tiptap.querySelectorAll(".ln-active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain("둘째 문단");
    // 문서 맨 앞(제목)으로 이동하면 강조도 옮겨간다
    editor.commands.setTextSelection(1);
    const active2 = tiptap.querySelectorAll(".ln-active");
    expect(active2.length).toBe(1);
    expect(active2[0].tagName).toBe("H1");
    editor.destroy();
  });

  it("문서가 바뀌어도 번호 위젯과 현재 줄 강조가 함께 유지된다", () => {
    const editor = makeEditor("첫 줄\n\n둘째 줄");
    const tiptap = editor.view.dom;
    editor.commands.focus();
    editor.commands.setTextSelection(1); // 첫 블록
    // 새 문단을 끝에 추가 (문서 변경)
    editor.commands.setTextSelection(editor.state.doc.content.size);
    editor.commands.insertContent("\n\n셋째 줄");
    const nums = tiptap.querySelectorAll(".ln-num");
    const active = tiptap.querySelectorAll(".ln-active");
    expect(nums.length).toBeGreaterThanOrEqual(3); // 번호 위젯 유지
    expect(active.length).toBe(1); // 현재 줄 강조는 항상 하나
    editor.destroy();
  });
});
