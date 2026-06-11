import { describe, expect, it } from "vitest";
import { isSafeHref, parseInline, parseMarkdown } from "./markdown";

describe("isSafeHref", () => {
  it("http/https/mailto는 허용", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:a@b.com")).toBe(true);
  });

  it("javascript: 등 위험한 스킴은 거부", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("/relative")).toBe(false);
  });
});

describe("parseInline", () => {
  it("일반 텍스트는 하나의 텍스트 토큰", () => {
    expect(parseInline("그냥 텍스트")).toEqual([{ type: "text", value: "그냥 텍스트" }]);
  });

  it("**bold** 를 인식한다", () => {
    expect(parseInline("a **b** c")).toEqual([
      { type: "text", value: "a " },
      { type: "bold", value: "b" },
      { type: "text", value: " c" },
    ]);
  });

  it("`code` 와 *italic* 를 인식한다", () => {
    expect(parseInline("`x` and *y*")).toEqual([
      { type: "code", value: "x" },
      { type: "text", value: " and " },
      { type: "italic", value: "y" },
    ]);
  });

  it("안전한 링크는 link 토큰", () => {
    expect(parseInline("[Google](https://google.com)")).toEqual([
      { type: "link", text: "Google", href: "https://google.com" },
    ]);
  });

  it("위험한 링크는 텍스트로 남는다", () => {
    const out = parseInline("[x](javascript:alert(1))");
    expect(out.every((n) => n.type === "text")).toBe(true);
  });

  it("코드 안의 별표는 강조로 해석하지 않는다", () => {
    expect(parseInline("`a*b*c`")).toEqual([{ type: "code", value: "a*b*c" }]);
  });
});

describe("parseMarkdown", () => {
  it("문단을 만든다", () => {
    const blocks = parseMarkdown("첫 문단\n계속\n\n둘째 문단");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[1].type).toBe("paragraph");
  });

  it("펜스 코드블록을 언어와 함께 파싱한다", () => {
    const blocks = parseMarkdown("설명\n\n```ts\nconst a = 1;\n```\n");
    const code = blocks.find((b) => b.type === "code");
    expect(code).toEqual({ type: "code", lang: "ts", value: "const a = 1;" });
  });

  it("닫는 펜스가 없어도 끝까지 코드로 본다", () => {
    const blocks = parseMarkdown("```\nx\ny");
    expect(blocks[0]).toEqual({ type: "code", lang: null, value: "x\ny" });
  });

  it("코드블록 안의 # 는 헤딩이 아니다", () => {
    const blocks = parseMarkdown("```\n# not a heading\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
  });

  it("헤딩 레벨을 인식한다", () => {
    const blocks = parseMarkdown("## 제목");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
  });

  it("비순서/순서 목록을 구분한다", () => {
    const blocks = parseMarkdown("- a\n- b\n\n1. c\n2. d");
    const lists = blocks.filter((b) => b.type === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ ordered: false });
    expect(lists[1]).toMatchObject({ ordered: true });
    if (lists[0].type === "list") expect(lists[0].items).toHaveLength(2);
  });

  it("인용을 파싱한다", () => {
    const blocks = parseMarkdown("> 인용문\n> 이어짐");
    expect(blocks[0].type).toBe("quote");
  });

  it("HTML 은 텍스트로 취급한다 (주입 방지)", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks[0].type).toBe("paragraph");
    if (blocks[0].type === "paragraph") {
      expect(blocks[0].children).toEqual([
        { type: "text", value: "<script>alert(1)</script>" },
      ]);
    }
  });
});
