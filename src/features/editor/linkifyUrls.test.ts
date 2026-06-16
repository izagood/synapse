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
});
