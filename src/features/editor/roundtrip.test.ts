// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";

// md → 에디터 → md 라운드트립 검증 (NFR-3의 핵심 리스크 가드).
// 포맷은 정규화될 수 있으므로 (1) 한 번 더 돌려도 변하지 않는 안정성과
// (2) 의미 보존(핵심 구문 생존)을 검사한다.
function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

const CASES: Record<string, { input: string; mustContain: string[] }> = {
  headings: {
    input: "# 제목 1\n\n## 제목 2\n\n본문 문단",
    mustContain: ["# 제목 1", "## 제목 2", "본문 문단"],
  },
  emphasis: {
    input: "이건 **굵게** 그리고 *기울임* 그리고 `코드` 그리고 ~~취소선~~",
    mustContain: ["굵게", "기울임", "`코드`", "취소선"],
  },
  lists: {
    input: "- 하나\n- 둘\n  - 둘의 자식\n\n1. 첫째\n2. 둘째",
    mustContain: ["- 하나", "- 둘의 자식", "1. 첫째", "2. 둘째"],
  },
  taskList: {
    input: "- [ ] 미완료 작업\n- [x] 완료된 작업",
    mustContain: ["- [ ] 미완료 작업", "- [x] 완료된 작업"],
  },
  codeBlock: {
    input: '```ts\nconst x: number = 1;\n```',
    mustContain: ["```ts", "const x: number = 1;"],
  },
  blockquoteAndHr: {
    input: "> 인용문입니다\n\n---\n\n다음 문단",
    mustContain: ["> 인용문입니다", "---", "다음 문단"],
  },
  link: {
    input: "[Synapse](https://github.com/izagood/synapse) 링크",
    mustContain: ["[Synapse](https://github.com/izagood/synapse)"],
  },
};

describe("markdown roundtrip (tiptap-markdown)", () => {
  it("preserves tables (가장 치명적이었던 손상 케이스)", () => {
    const table = "| 이름 | 값 |\n| --- | --- |\n| a | 1 |\n| b | 2 |";
    const out = roundtrip(table);
    expect(out).toContain("| 이름 | 값 |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| a | 1 |");
    expect(out).toContain("| b | 2 |");
    expect(roundtrip(out)).toBe(out);
  });

  it("keeps task lists tight (항목 사이 빈 줄 삽입 금지)", () => {
    const input = "- [ ] 미완료\n- [x] 완료\n- [ ] 셋째";
    expect(roundtrip(input)).toBe(input);
  });

  it("does not alter a typical note exactly (정확 일치)", () => {
    const note = [
      "# | TODO |",
      "",
      "- [Cloud weekly](https://example.com/weekly)",
      "- kv cache",
      "  - Mooncake",
      "",
      "일반 문단 snake_case_name 그리고 | 파이프 | 텍스트",
      "",
      "- [ ] 미완료",
      "- [x] 완료",
    ].join("\n");
    expect(roundtrip(note)).toBe(note);
  });

  for (const [name, { input, mustContain }] of Object.entries(CASES)) {
    it(`${name}: preserves semantics and is idempotent`, () => {
      const once = roundtrip(input);
      for (const fragment of mustContain) {
        expect(once).toContain(fragment);
      }
      // 두 번째 라운드트립에서 더는 변형이 없어야 한다
      expect(roundtrip(once)).toBe(once);
    });
  }
});
