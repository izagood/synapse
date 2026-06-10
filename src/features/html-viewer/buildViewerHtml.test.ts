// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildViewerHtml } from "./buildViewerHtml";

const options = {
  baseUrl: "asset://localhost/ws/notes",
  resolveLocal: (rel: string) => `asset://localhost/ws/notes/${rel}`,
  allowNetwork: false,
};

describe("buildViewerHtml", () => {
  it("default mode strips scripts but keeps anchors and document styles", () => {
    const html = `<html><head><style>h1{color:red}</style></head><body>
      <a href="#section-2">이동</a><h1 id="section-2">제목</h1>
      <script>alert(1)</script></body></html>`;
    const out = buildViewerHtml(html, { ...options, allowScripts: false });
    expect(out).not.toContain("alert(1)");
    expect(out).toContain(`href="#section-2"`);
    expect(out).toContain(`id="section-2"`);
    expect(out).toContain("color:red");
    expect(out).toContain(`<base href="asset://localhost/ws/notes/">`);
  });

  it("script mode keeps the document as-is with an injected base", () => {
    const html = `<html><head><title>t</title></head><body><script>init()</script></body></html>`;
    const out = buildViewerHtml(html, { ...options, allowScripts: true });
    expect(out).toContain("init()");
    // base는 head 맨 앞에 주입된다
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<title>"));
  });

  it("wraps fragments into a full document with default styles", () => {
    const out = buildViewerHtml("<h1>조각</h1>", { ...options, allowScripts: false });
    expect(out).toContain("<head>");
    expect(out).toContain("<h1>조각</h1>");
    expect(out).toContain("max-width: 860px"); // 자체 스타일이 없으니 기본 스타일 적용
  });

  it("skips default styles when the document brings its own", () => {
    const out = buildViewerHtml("<style>body{background:#000}</style><p>x</p>", {
      ...options,
      allowScripts: false,
    });
    expect(out).toContain("background:#000");
    expect(out).not.toContain("max-width: 860px");
  });
});
