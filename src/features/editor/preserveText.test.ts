// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";

function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

describe("평문 각도 괄호 보존", () => {
  const CASES = [
    ["템플릿 자리표시자", "# <구조 이름>"],
    ["본문 자리표시자", "구조 파일: `structures/<슬러그>/README.md`"],
    ["부등호", "a < b 이고 c > d"],
    ["제네릭 표기", "Vec<String> 을 쓴다"],
  ] as const;

  for (const [name, input] of CASES) {
    it(`${name}: ${input}`, () => {
      const out = roundtrip(input);
      expect(out).not.toContain("&lt;");
      expect(out).not.toContain("&gt;");
      expect(roundtrip(out)).toBe(out); // 멱등
    });
  }

  it("자리표시자가 든 템플릿 한 줄이 바이트 그대로 보존된다", () => {
    const input = "- **수** 이후 골격 고정 → [[structures/<슬러그>]]";
    expect(roundtrip(input).trim()).toBe(input);
  });

  it("위험한 원시 HTML은 여전히 제거된다", () => {
    // escapeHTML 제거가 스크립트 주입 경로를 열지 않음을 못박는다.
    // (파싱 시점에 이미 제거되므로 직렬화 단계와 무관하다)
    const out = roundtrip("<script>alert(1)</script>");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("<script");
  });

  it("마크다운 특수문자 이스케이프는 그대로 유지된다", () => {
    // esc() 는 건드리지 않았으므로 기존 동작이 남아야 한다.
    const out = roundtrip("[클릭](javascript:alert(1))");
    expect(out).not.toContain("[클릭](javascript:");
    expect(out).toContain("\\[클릭\\]");
  });
});
