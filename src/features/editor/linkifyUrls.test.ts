import { describe, expect, it } from "vitest";
import { findUrls } from "./linkifyUrls";

describe("findUrls", () => {
  it("맨 http(s) URL을 위치와 함께 찾는다", () => {
    const text = "https://docs.google.com/document/d/1He15AiDPHfTn4/edit?tab=t.0";
    expect(findUrls(text)).toEqual([{ url: text, start: 0, end: text.length }]);
  });

  it("문장 중간의 URL도 찾는다", () => {
    const text = "관련 자료 https://github.com/org/repo/blob/main/x.yaml#L4 끝";
    const url = "https://github.com/org/repo/blob/main/x.yaml#L4";
    const start = text.indexOf(url);
    expect(findUrls(text)).toEqual([{ url, start, end: start + url.length }]);
  });

  it("한 줄에 여러 URL을 찾는다", () => {
    const text = "http://a.com 그리고 https://b.org/p 둘";
    expect(findUrls(text).map((m) => m.url)).toEqual(["http://a.com", "https://b.org/p"]);
  });

  it("URL 뒤 문장 부호는 링크에서 제외한다", () => {
    expect(findUrls("자세히는 https://example.com/page. 참고").map((m) => m.url)).toEqual([
      "https://example.com/page",
    ]);
    expect(findUrls("(https://example.com)").map((m) => m.url)).toEqual([
      "https://example.com",
    ]);
  });

  it("스킴 없는 텍스트는 링크화하지 않는다", () => {
    expect(findUrls("github.com/org/repo 와 www.example.com")).toEqual([]);
  });

  // URL 경로의 괄호는 정당한 문자다. 여는 괄호를 무조건 경계로 보면
  // 위키백과 링크가 잘린다.
  it("URL 경로 안의 짝맞는 괄호는 URL의 일부로 남긴다", () => {
    const url = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
    expect(findUrls(url).map((m) => m.url)).toEqual([url]);
    expect(findUrls(`${url} 참고`).map((m) => m.url)).toEqual([url]);
  });

  it("짝이 맞지 않는 닫는 괄호는 본문 것으로 보고 떼어낸다", () => {
    expect(findUrls("(https://example.com/a)").map((m) => m.url)).toEqual([
      "https://example.com/a",
    ]);
    expect(findUrls("[https://example.com]").map((m) => m.url)).toEqual(["https://example.com"]);
    expect(findUrls("{https://example.com}").map((m) => m.url)).toEqual(["https://example.com"]);
    expect(findUrls("«https://example.com»").map((m) => m.url)).toEqual(["https://example.com"]);
    expect(findUrls("`https://example.com`").map((m) => m.url)).toEqual(["https://example.com"]);
  });

  // 전각 문장부호는 URL에 쓰이지 않고 한국어·일본어 본문에서 URL 바로 뒤에 붙는다.
  it("전각 문장부호는 URL 경계로 본다", () => {
    expect(findUrls("https://example.com。").map((m) => m.url)).toEqual(["https://example.com"]);
    expect(findUrls("https://example.com、다음").map((m) => m.url)).toEqual([
      "https://example.com",
    ]);
    expect(findUrls("https://example.com…").map((m) => m.url)).toEqual(["https://example.com"]);
  });

  it("start/end가 잘라낸 URL과 정확히 일치한다", () => {
    const text = "앞 (https://example.com/page) 뒤";
    for (const m of findUrls(text)) {
      expect(text.slice(m.start, m.end)).toBe(m.url);
    }
  });

  it("같은 텍스트를 반복 호출해도 결과가 같다(전역 정규식 상태)", () => {
    const text = "https://a.com 와 https://b.com";
    expect(findUrls(text)).toEqual(findUrls(text));
  });
});
