// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize";

const resolveLocal = (rel: string) => `asset://resolved/${rel}`;

describe("sanitizeHtml", () => {
  it("strips scripts and event handlers", () => {
    const out = sanitizeHtml(
      `<p onclick="alert(1)">본문</p><script>alert(2)</script>`,
      { resolveLocal },
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("본문");
  });

  it("removes iframes, forms and external stylesheets", () => {
    const out = sanitizeHtml(
      `<iframe src="https://evil.test"></iframe><form action="/x"><input></form><link rel="stylesheet" href="https://cdn.test/a.css">`,
      { resolveLocal },
    );
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("form");
    expect(out).not.toContain("cdn.test");
  });

  it("blocks external images by default, keeps them when allowed", () => {
    const html = `<img src="https://tracker.test/pixel.png">`;
    expect(sanitizeHtml(html, { resolveLocal })).not.toContain("tracker.test");
    expect(
      sanitizeHtml(html, { resolveLocal, allowNetwork: true }),
    ).toContain("tracker.test");
  });

  it("rewrites relative image paths through resolveLocal", () => {
    const out = sanitizeHtml(`<img src="assets/diagram.png">`, { resolveLocal });
    expect(out).toContain(`src="asset://resolved/assets/diagram.png"`);
  });

  it("keeps data: images and inline styles", () => {
    const out = sanitizeHtml(
      `<style>h1 { color: tomato; }</style><img src="data:image/png;base64,AAAA"><h1 style="margin:0">제목</h1>`,
      { resolveLocal },
    );
    expect(out).toContain("color: tomato");
    expect(out).toContain("data:image/png;base64,AAAA");
    expect(out).toContain(`style="margin:0"`);
  });

  it("neutralizes javascript: links", () => {
    const out = sanitizeHtml(`<a href="javascript:alert(1)">x</a>`, { resolveLocal });
    expect(out).not.toContain("javascript:");
  });
});
