// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  htmlExportPath,
  markdownToHtmlBody,
  markdownToStandaloneHtml,
  titleFromPath,
} from "./markdownToHtml";
import { htmlToMarkdown } from "./htmlToMarkdown";

describe("path helpers", () => {
  it("htmlExportPath swaps .md/.markdown for .html", () => {
    expect(htmlExportPath("/vault/note.md")).toBe("/vault/note.html");
    expect(htmlExportPath("/vault/doc.markdown")).toBe("/vault/doc.html");
    expect(htmlExportPath("/vault/no-ext")).toBe("/vault/no-ext.html");
  });

  it("titleFromPath strips directory and extension", () => {
    expect(titleFromPath("/vault/sub/내 노트.md")).toBe("내 노트");
    expect(titleFromPath("page.html")).toBe("page");
  });
});

describe("markdownToHtmlBody (마크다운 → HTML 본문)", () => {
  it("renders headings and paragraphs", () => {
    const out = markdownToHtmlBody("# 제목\n\n본문");
    expect(out).toContain("<h1>제목</h1>");
    expect(out).toContain("본문");
  });

  it("renders code blocks with language class", () => {
    const out = markdownToHtmlBody("```ts\nconst x = 1;\n```");
    expect(out).toMatch(/<pre>/);
    expect(out).toContain("const x = 1;");
    expect(out).toContain("language-ts");
  });

  it("renders tables", () => {
    const out = markdownToHtmlBody(
      "| 이름 | 값 |\n| --- | --- |\n| a | 1 |",
    );
    expect(out).toContain("<table");
    expect(out).toContain("이름");
    expect(out).toContain("<td");
  });

  it("renders links", () => {
    const out = markdownToHtmlBody("[사이트](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("사이트");
  });

  it("excludes frontmatter from the body (frontmatter 제외)", () => {
    const out = markdownToHtmlBody("---\ntitle: 비밀\n---\n\n본문만");
    expect(out).not.toContain("비밀");
    expect(out).toContain("본문만");
  });
});

describe("markdownToStandaloneHtml (자기완결적 HTML 내보내기)", () => {
  it("produces a complete document with charset, title, and style", () => {
    const out = markdownToStandaloneHtml("# 안녕", { title: "내 노트" });
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain("<title>내 노트</title>");
    expect(out).toContain("<style>");
    expect(out).toContain("<h1>안녕</h1>");
  });

  it("escapes the title to avoid injection", () => {
    const out = markdownToStandaloneHtml("x", {
      title: '</title><script>alert(1)</script>',
    });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("falls back to Untitled when no title given", () => {
    const out = markdownToStandaloneHtml("x");
    expect(out).toContain("<title>Untitled</title>");
  });

  it("contains no external dependencies or runtime scripts (자기완결)", () => {
    const out = markdownToStandaloneHtml("# 안녕\n\n[x](https://example.com)");
    // 본문 링크 외에 스크립트/링크 태그(외부 리소스)가 없어야 한다
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<link\b/i);
  });
});

describe("HTML ↔ MD 라운드트립", () => {
  // MD → HTML → MD: 핵심 구조가 살아남는지 (정규화는 허용)
  const cases: Record<string, { md: string; mustContain: string[] }> = {
    headings: { md: "# 제목 1\n\n## 제목 2", mustContain: ["# 제목 1", "## 제목 2"] },
    emphasis: {
      md: "이건 **굵게** 그리고 *기울임*",
      mustContain: ["**굵게**", "*기울임*"],
    },
    lists: {
      md: "- 하나\n- 둘\n\n1. 첫째\n2. 둘째",
      mustContain: ["- 하나", "1. 첫째", "2. 둘째"],
    },
    codeBlock: {
      md: "```ts\nconst x = 1;\n```",
      mustContain: ["```ts", "const x = 1;"],
    },
    link: {
      md: "[Synapse](https://example.com)",
      mustContain: ["[Synapse](https://example.com)"],
    },
    table: {
      md: "| 이름 | 값 |\n| --- | --- |\n| a | 1 |\n| b | 2 |",
      mustContain: ["| 이름 | 값 |", "| a | 1 |", "| b | 2 |"],
    },
    blockquote: { md: "> 인용문", mustContain: ["> 인용문"] },
  };

  for (const [name, { md, mustContain }] of Object.entries(cases)) {
    it(`${name}: MD → HTML → MD preserves structure`, () => {
      const html = markdownToHtmlBody(md);
      const back = htmlToMarkdown(html);
      for (const fragment of mustContain) {
        expect(back).toContain(fragment);
      }
    });
  }

  it("HTML → MD → HTML preserves table and code", () => {
    const html =
      "<h1>문서</h1>" +
      "<table><thead><tr><th>k</th><th>v</th></tr></thead>" +
      "<tbody><tr><td>a</td><td>1</td></tr></tbody></table>" +
      '<pre><code class="language-js">let y = 2;</code></pre>';
    const md = htmlToMarkdown(html);
    const back = markdownToHtmlBody(md);
    expect(back).toContain("<table");
    expect(back).toContain("<pre>");
    expect(back).toContain("let y = 2;");
    expect(back).toContain("문서");
  });
});
