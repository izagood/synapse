// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildViewerHtml } from "./buildViewerHtml";

const options = {
  baseUrl: "asset://localhost/ws/notes",
  resolveLocal: (rel: string) => `asset://localhost/ws/notes/${rel}`,
  allowNetwork: false,
};

describe("buildViewerHtml", () => {
  it("default mode strips document scripts but keeps anchors/ids/styles", () => {
    const html = `<html><head><style>h1{color:red}</style></head><body>
      <a href="#section-2">이동</a><h1 id="section-2">제목</h1>
      <script>alert(1)</script><div onclick="alert(2)">x</div></body></html>`;
    const out = buildViewerHtml(html, { ...options, allowScripts: false });
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("onclick");
    expect(out).toContain(`href="#section-2"`);
    expect(out).toContain(`id="section-2"`);
    expect(out).toContain("color:red");
  });

  it("injects charset before base in every mode (한글 깨짐 방지)", () => {
    for (const allowScripts of [false, true]) {
      const out = buildViewerHtml("<html><head><title>t</title></head><body>한글</body></html>", {
        ...options,
        allowScripts,
      });
      const charsetAt = out.indexOf(`<meta charset="utf-8">`);
      expect(charsetAt).toBeGreaterThanOrEqual(0);
      expect(charsetAt).toBeLessThan(out.indexOf("<base"));
      expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<title>"));
    }
  });

  it("appends the viewer runtime for #anchor scrolling and external links", () => {
    const out = buildViewerHtml("<p>x</p>", { ...options, allowScripts: false });
    expect(out).toContain("synapse:open-external");
    expect(out).toContain("scrollIntoView");
    // 런타임은 정화 이후 마지막에 붙는다 (문서 내용이 끼어들 수 없음)
    expect(out.trimEnd().endsWith("</script>")).toBe(true);
  });

  it("script mode keeps the document as-is plus runtime", () => {
    const html = `<html><head><title>t</title></head><body><script>init()</script></body></html>`;
    const out = buildViewerHtml(html, { ...options, allowScripts: true });
    expect(out).toContain("init()");
    expect(out).toContain("synapse:open-external");
  });

  it("wraps fragments with default styles when no own styles exist", () => {
    const out = buildViewerHtml("<h1>조각</h1>", { ...options, allowScripts: false });
    expect(out).toContain("<h1>조각</h1>");
    expect(out).toContain("max-width: 860px");
    const withOwn = buildViewerHtml("<style>body{background:#000}</style><p>x</p>", {
      ...options,
      allowScripts: false,
    });
    expect(withOwn).toContain("background:#000");
    expect(withOwn).not.toContain("max-width: 860px");
  });
});
