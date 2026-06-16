import { describe, expect, it } from "vitest";
import { buildDrawioHtml } from "./buildDrawioHtml";

const SAMPLE_XML =
  '<mxfile><diagram id="a" name="Page-1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '</root></mxGraphModel></diagram></mxfile>';

describe("buildDrawioHtml", () => {
  it("뷰어 컨테이너와 번들 스크립트를 포함한다", () => {
    const html = buildDrawioHtml(SAMPLE_XML, "asset://viewer.js");
    expect(html).toContain('class="mxgraph"');
    expect(html).toContain('data-mxgraph=');
    expect(html).toContain('<script src="asset://viewer.js">');
  });

  it("XML을 data-mxgraph JSON 안에 담는다", () => {
    const html = buildDrawioHtml(SAMPLE_XML, "asset://viewer.js");
    const m = html.match(/data-mxgraph='([^']*)'/);
    expect(m).not.toBeNull();
    // 속성값을 디코드하면 다시 원래 XML을 담은 JSON 설정이 나온다
    const decoded = m![1]
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const config = JSON.parse(decoded);
    expect(config.xml).toBe(SAMPLE_XML);
    expect(config.lightbox).toBe(false);
  });

  it("XML이나 URL의 따옴표가 속성을 깨뜨리지 않는다", () => {
    const tricky = `<mxfile label="it's a 'test' & <fun>"></mxfile>`;
    const html = buildDrawioHtml(tricky, `asset://v.js?q="x"`);
    // 단일 인용 속성 경계가 본문 따옴표로 조기 종료되지 않아야 한다
    const m = html.match(/data-mxgraph='([^']*)'/);
    expect(m).not.toBeNull();
    const decoded = m![1]
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(JSON.parse(decoded).xml).toBe(tricky);
    // 스크립트 URL의 큰따옴표는 이스케이프되어 src 속성을 깨지 않는다
    expect(html).toContain("&quot;x&quot;");
  });
});
