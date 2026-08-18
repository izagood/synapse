// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { splitFrontmatter } from "./frontmatter";
import { hasRoundtripContentLoss } from "./roundtripSafety";

function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

describe("roundtrip safety detection", () => {
  it("does not flag a normal frontmatter document", () => {
    const doc = [
      "---",
      "title: Rust",
      "tags: [study, rust]",
      "---",
      "",
      "# 04. 컬렉션 · 이터레이터 · 클로저",
      "",
      "[← 목차로](../README.md)",
    ].join("\n");
    const { body } = splitFrontmatter(doc);
    expect(hasRoundtripContentLoss(body, roundtrip(body))).toBe(false);
  });

  it("allows common serializer normalization", () => {
    const source = [
      "# 04. 컬렉션 · 이터레이터 · 클로저",
      "",
      "문장 안의 이스케이프된 파이프: a \\| b",
      "",
      "| 이름 | 값 |",
      "|---|---|",
      "| a | 1 |",
      "",
      "![shot](스크린샷-2026-06-11-오후-3.24.15.png)",
    ].join("\n");

    expect(hasRoundtripContentLoss(source, roundtrip(source))).toBe(false);
  });

  it("treats percent-encoded image destinations as the same target", () => {
    const original = "![shot](스크린샷-2026-06-11-오후-3.24.15.png)";
    const serialized =
      "![shot](%EC%8A%A4%ED%81%AC%EB%A6%B0%EC%83%B7-2026-06-11-%EC%98%A4%ED%9B%84-3.24.15.png)";

    expect(hasRoundtripContentLoss(original, serialized)).toBe(false);
  });

  it("does not flag preserved raw HTML", () => {
    const html = '<div class="note">hello <span>world</span></div>';
    const formatted = '<div class="note">\nhello <span>world</span>\n</div>';

    expect(hasRoundtripContentLoss(html, formatted)).toBe(false);
  });

  it("flags dropped text content", () => {
    expect(hasRoundtripContentLoss("# 제목\n\n본문", "# 제목")).toBe(true);
  });

  it("flags dropped links and images", () => {
    expect(hasRoundtripContentLoss("[Synapse](https://example.com)", "Synapse")).toBe(true);
    expect(hasRoundtripContentLoss("![diagram](diagram.png)", "")).toBe(true);
  });
  // markdown-it은 1이 아닌 숫자로 시작하는 순서 목록에만 ordered_list_open 의
  // start 속성을 붙이는데, 그 값이 number다(타입 선언은 [string, string][]).
  // 문자열로 가정하고 정규화하면 TypeError가 나면서 저장 경로 전체가 죽는다.
  it("handles ordered lists that start at a number other than 1", () => {
    expect(() => hasRoundtripContentLoss("2. 둘째\n", "2. 둘째\n")).not.toThrow();
    expect(() => hasRoundtripContentLoss("10. 열번째\n", "10. 열번째\n")).not.toThrow();
    expect(hasRoundtripContentLoss("2. 둘째\n", "2. 둘째\n")).toBe(false);
    expect(hasRoundtripContentLoss("3. 셋째\n", "")).toBe(true);
  });
});
