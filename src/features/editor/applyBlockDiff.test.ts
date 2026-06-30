// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./extensions";
import { parseMarkdownToDoc, diffTopLevelBlocks } from "./applyBlockDiff";

let ed: Editor | null = null;
afterEach(() => {
  ed?.destroy();
  ed = null;
});
function editor(md = ""): Editor {
  ed = new Editor({ extensions: editorExtensions({ withPlaceholder: false }), content: md });
  return ed;
}

describe("parseMarkdownToDoc", () => {
  it("마크다운을 라이브 schema 문서로 파싱한다 (노드 타입 동일)", () => {
    const e = editor("# A\n\nbody");
    const doc = parseMarkdownToDoc(e, "# A\n\nbody");
    // 같은 schema라 최상위 첫 노드 타입이 라이브 문서와 동일하다
    expect(doc.firstChild?.type).toBe(e.state.doc.firstChild?.type);
    expect(doc.childCount).toBe(e.state.doc.childCount);
  });
});

describe("diffTopLevelBlocks", () => {
  it("여러 구역이 동시에 바뀌면 각 변경 run을 hunk로 낸다", () => {
    const e = editor();
    const oldDoc = parseMarkdownToDoc(e, "# A\n\n# B\n\n# C\n\n# D\n\n# E");
    const newDoc = parseMarkdownToDoc(e, "# A\n\n# B2\n\n# C\n\n# D2\n\n# E");
    const hunks = diffTopLevelBlocks(oldDoc, newDoc);
    // B(인덱스1)와 D(인덱스3) 두 구역 → hunk 2개
    expect(hunks.length).toBe(2);
    // 위치 오름차순, 서로 겹치지 않음
    expect(hunks[0].to).toBeLessThanOrEqual(hunks[1].from);
  });

  it("변경 없음이면 hunk가 없다", () => {
    const e = editor();
    const a = parseMarkdownToDoc(e, "# A\n\n# B");
    const b = parseMarkdownToDoc(e, "# A\n\n# B");
    expect(diffTopLevelBlocks(a, b)).toEqual([]);
  });

  it("끝에 블록 추가는 꼬리 hunk 하나다", () => {
    const e = editor();
    const a = parseMarkdownToDoc(e, "# A\n\n# B");
    const b = parseMarkdownToDoc(e, "# A\n\n# B\n\n# C");
    const hunks = diffTopLevelBlocks(a, b);
    expect(hunks.length).toBe(1);
    expect(hunks[0].nodes.length).toBe(1); // # C 한 블록 삽입
  });
});
