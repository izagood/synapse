// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { parseMarkdownToDoc, diffTopLevelBlocks, applyBlockDiff } from "./applyBlockDiff";

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

describe("applyBlockDiff", () => {
  it("다중 구역 변경: 안 바뀐 블록 노드는 동일 인스턴스로 보존된다", () => {
    const e = editor("# A\n\n# B\n\n# C\n\n# D\n\n# E");
    const beforeA = e.state.doc.child(0);
    const beforeC = e.state.doc.child(2);
    const ok = applyBlockDiff(e, "# A\n\n# B2\n\n# C\n\n# D2\n\n# E");
    expect(ok).toBe(true);
    // 안 바뀐 A, C는 같은 노드 인스턴스(===)로 남는다
    expect(e.state.doc.child(0)).toBe(beforeA);
    expect(e.state.doc.child(2)).toBe(beforeC);
    expect(getMarkdown(e)).toContain("# B2");
    expect(getMarkdown(e)).toContain("# D2");
  });

  it("안 바뀐 블록에 둔 커서는 위치가 보존된다", () => {
    const e = editor("# A\n\n# B\n\n# C");
    // C 블록 안에 커서 (문서 끝 근처)
    const posInC = e.state.doc.content.size - 1;
    e.commands.setTextSelection(posInC);
    const before = e.state.selection.from;
    applyBlockDiff(e, "# A2\n\n# B\n\n# C"); // A만 변경
    // 앞 블록 A의 +1글자만큼만 매핑되어 커서가 여전히 C 영역의 같은 지점을 가리킨다
    expect(e.state.selection.from).toBe(before + 1);
    expect(getMarkdown(e)).toContain("# C");
  });

  it("최종 직렬화가 새 본문과 일치한다(무손실)", () => {
    const e = editor("# A\n\n- 하나\n- 둘\n\n# C");
    applyBlockDiff(e, "# A\n\n- 하나\n- 둘\n- 셋\n\n# C");
    expect(getMarkdown(e)).toContain("- 셋");
    expect(getMarkdown(e)).toContain("# C");
  });
});
