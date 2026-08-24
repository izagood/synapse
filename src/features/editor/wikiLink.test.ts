// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { isValidWikiInner } from "./wikiLink";

function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

describe("위키링크 라운드트립", () => {
  // 회귀의 핵심: 이 케이스들이 깨지면 links.rs 가 링크를 인식하지 못하게 된다.
  const CASES = [
    ["단순", "[[f7-weakness]]"],
    ["한글", "[[개발-순서]]"],
    ["별칭", "[[전투-시스템|전투]]"],
    ["앵커", "[[갬빗#티어-7]]"],
    ["앵커+별칭", "[[갬빗#티어-7|티어 7]]"],
    ["경로", "[[structures/carlsbad]]"],
    ["공백 포함", "[[한글 노트 이름]]"],
  ] as const;

  for (const [name, link] of CASES) {
    it(`${name}: ${link} 이 바이트 그대로 보존된다`, () => {
      const input = `본문에 ${link} 가 있다.`;
      const out = roundtrip(input);
      expect(out).toContain(link);
      // 이스케이프되지 않아야 한다 — 이게 실제로 깨졌던 부분.
      expect(out).not.toContain("\\[\\[");
      expect(roundtrip(out)).toBe(out); // 멱등
    });
  }

  it("목록 항목 안에서도 보존된다", () => {
    const input = "- [[f7-weakness]] — 교훈\n- [[development-order]] — 순서";
    const out = roundtrip(input);
    expect(out).toContain("[[f7-weakness]]");
    expect(out).toContain("[[development-order]]");
    expect(out).not.toContain("\\[\\[");
  });

  it("표 셀 안에서도 보존된다", () => {
    const out = roundtrip("| 구조 | 링크 |\n| --- | --- |\n| 칼스바드 | [[carlsbad]] |");
    expect(out).toContain("[[carlsbad]]");
    expect(out).not.toContain("\\[\\[");
  });

  it("코드 펜스 안의 [[...]] 는 링크로 바뀌지 않는다", () => {
    const input = "```\n[[리터럴]]\n```";
    const out = roundtrip(input);
    expect(out).toContain("[[리터럴]]");
    expect(roundtrip(out)).toBe(out);
  });

  it("위키링크는 이스케이프되지 않지만 위험 스킴은 여전히 차단된다", () => {
    // 두 동작이 공존함을 못박는다. 전역 esc() 를 건드리지 않았다는 증거.
    // 위험 스킴은 링크 마크가 떨어지고 브래킷이 이스케이프된 평문으로 남는다
    // (roundtrip.test.ts 의 기존 보안 테스트와 같은 판정 기준).
    const out = roundtrip("[[노트]] 그리고 [클릭](javascript:alert(1))");
    expect(out).toContain("[[노트]]");
    expect(out).not.toContain("[클릭](javascript:");
    expect(out).toContain("\\[클릭\\]");
  });

  it("닫히지 않은 [[ 는 위키링크가 아니다", () => {
    const out = roundtrip("[[닫히지 않음");
    expect(roundtrip(out)).toBe(out); // 예외 없이 안정적으로 처리
  });
});

describe("isValidWikiInner", () => {
  it("정상 대상을 허용한다", () => {
    expect(isValidWikiInner("노트")).toBe(true);
    expect(isValidWikiInner("a|b")).toBe(true);
    expect(isValidWikiInner("a#b")).toBe(true);
  });

  it("빈 문자열·개행·중첩 대괄호를 거부한다", () => {
    expect(isValidWikiInner("")).toBe(false);
    expect(isValidWikiInner("a\nb")).toBe(false);
    expect(isValidWikiInner("a[b")).toBe(false);
    expect(isValidWikiInner("a]b")).toBe(false);
  });
});
