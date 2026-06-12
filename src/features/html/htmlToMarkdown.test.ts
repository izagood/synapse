// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, sanitizeForMarkdown } from "./htmlToMarkdown";

describe("sanitizeForMarkdown (위험 태그/스크립트 정화)", () => {
  it("strips <script> tags and their contents", () => {
    const out = sanitizeForMarkdown(
      "<p>안녕</p><script>alert('xss')</script>",
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert");
    expect(out).toContain("안녕");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeForMarkdown('<p onclick="steal()">click</p>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("steal");
    expect(out).toContain("click");
  });

  it("removes iframe/object/embed/form", () => {
    const out = sanitizeForMarkdown(
      '<iframe src="evil"></iframe><object></object><embed><form><input></form><p>ok</p>',
    );
    expect(out).not.toMatch(/<iframe|<object|<embed|<form|<input/i);
    expect(out).toContain("ok");
  });

  it("drops javascript: link destinations but keeps the text", () => {
    const out = sanitizeForMarkdown('<a href="javascript:alert(1)">link</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("link");
  });

  it("strips <style> blocks", () => {
    const out = sanitizeForMarkdown("<style>body{display:none}</style><p>x</p>");
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toContain("display:none");
    expect(out).toContain("x");
  });
});

describe("htmlToMarkdown (HTML → 편집 가능한 마크다운)", () => {
  it("converts headings", () => {
    expect(htmlToMarkdown("<h1>제목</h1>")).toBe("# 제목");
    expect(htmlToMarkdown("<h2>둘</h2>")).toBe("## 둘");
  });

  it("converts emphasis", () => {
    const out = htmlToMarkdown(
      "<p>이건 <strong>굵게</strong> 그리고 <em>기울임</em></p>",
    );
    expect(out).toContain("**굵게**");
    expect(out).toContain("*기울임*");
  });

  it("preserves inline code and code blocks (코드블록 보존)", () => {
    const inline = htmlToMarkdown("<p>변수 <code>x</code></p>");
    expect(inline).toContain("`x`");

    const block = htmlToMarkdown(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
    expect(block).toContain("```ts");
    expect(block).toContain("const x = 1;");
  });

  it("preserves links (링크 보존)", () => {
    const out = htmlToMarkdown('<p><a href="https://example.com">사이트</a></p>');
    expect(out).toContain("[사이트](https://example.com)");
  });

  it("drops javascript: links to plain text (위험 링크 비활성화)", () => {
    const out = htmlToMarkdown('<p><a href="javascript:alert(1)">위험</a></p>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("위험");
  });

  it("preserves tables (표 보존)", () => {
    const out = htmlToMarkdown(
      "<table><thead><tr><th>이름</th><th>값</th></tr></thead>" +
        "<tbody><tr><td>a</td><td>1</td></tr></tbody></table>",
    );
    expect(out).toContain("| 이름 | 값 |");
    expect(out).toContain("| a | 1 |");
  });

  it("converts ordered and unordered lists", () => {
    const ul = htmlToMarkdown("<ul><li>하나</li><li>둘</li></ul>");
    expect(ul).toContain("- 하나");
    expect(ul).toContain("- 둘");

    const ol = htmlToMarkdown("<ol><li>첫째</li><li>둘째</li></ol>");
    expect(ol).toContain("1. 첫째");
    expect(ol).toContain("2. 둘째");
  });

  it("converts blockquotes", () => {
    const out = htmlToMarkdown("<blockquote><p>인용</p></blockquote>");
    expect(out).toContain("> 인용");
  });

  it("handles a full HTML document (head/body 래퍼)", () => {
    const out = htmlToMarkdown(
      "<!doctype html><html><head><title>T</title><style>x{}</style></head>" +
        "<body><h1>문서</h1><p>본문</p></body></html>",
    );
    expect(out).toContain("# 문서");
    expect(out).toContain("본문");
    expect(out).not.toContain("x{}");
  });
});
