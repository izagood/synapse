import { describe, expect, it } from "vitest";
import {
  buildEditorUrl,
  emptyDrawioXml,
  handleEmbedEvent,
  isBlankDrawio,
  isFromEmbedFrame,
  shouldPersistDrawio,
} from "./drawioEmbed";

describe("buildEditorUrl", () => {
  it("enables embed/json protocol and offline-safe params", () => {
    const url = buildEditorUrl({ basePath: "vendor/drawio-app/index.html" });
    const q = new URL(url, "http://x/").searchParams;
    expect(q.get("embed")).toBe("1");
    expect(q.get("proto")).toBe("json");
    expect(q.get("offline")).toBe("1");
    expect(q.get("stealth")).toBe("1");
    expect(q.get("noSaveBtn")).toBe("1");
    expect(q.get("noExitBtn")).toBe("1");
    expect(url.startsWith("vendor/drawio-app/index.html?")).toBe(true);
  });

  it("forces light canvas with explicit dark=0 (not by omitting the param)", () => {
    // dark 를 생략하면 drawio 가 스스로 다크를 판정해(macOS WKWebView 는 OS 다크를
    // 따라감) 캔버스가 검정으로 떴다. 라이트 고정은 dark="0" 을 *명시* 해야 한다.
    const plain = new URL(buildEditorUrl({ basePath: "a" }), "http://x/").searchParams;
    expect(plain.get("dark")).toBe("0");
    const withLang = new URL(buildEditorUrl({ basePath: "a", lang: "ko" }), "http://x/").searchParams;
    expect(withLang.get("dark")).toBe("0");
  });

  it("disables MathJax with explicit math=0 (bundle has no math4/)", () => {
    // 번들에 math4/ 가 없는데 릴리스(tauri 프로토콜)는 누락 경로에 SPA fallback 으로
    // index.html 을 돌려줘, drawio 의 MathJax 로더가 HTML 을 JS 로 실행하다
    // SyntaxError 를 냈다. math=0 으로 로드 자체를 차단한다.
    const q = new URL(buildEditorUrl({ basePath: "a" }), "http://x/").searchParams;
    expect(q.get("math")).toBe("0");
  });

  it("adds lang only when requested", () => {
    const plain = new URL(buildEditorUrl({ basePath: "a" }), "http://x/").searchParams;
    expect(plain.get("lang")).toBeNull();
    const withLang = new URL(buildEditorUrl({ basePath: "a", lang: "ko" }), "http://x/").searchParams;
    expect(withLang.get("lang")).toBe("ko");
  });
});

describe("isFromEmbedFrame", () => {
  // 실제 Window 가 없는 테스트 환경이라 임의 객체로 동일성만 검증한다.
  const frame = {} as unknown as Window;
  const other = {} as unknown as Window;

  it("accepts a message whose source matches the editor iframe", () => {
    expect(isFromEmbedFrame(frame as unknown as MessageEventSource, frame)).toBe(true);
  });

  it("rejects a message from a different window", () => {
    expect(isFromEmbedFrame(other as unknown as MessageEventSource, frame)).toBe(false);
  });

  it("trusts a null source (macOS WKWebView drops e.source on iframe→parent posts)", () => {
    // 이게 핵심 회귀 방지: null source 를 버리면 drawio init 이 사라져
    // 에디터가 빈 채로 멈춘다. null 은 통과시켜야 한다.
    expect(isFromEmbedFrame(null, frame)).toBe(true);
  });
});

const SEEDED = '<mxfile><diagram><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="A" vertex="1" parent="1"/>' +
  "</root></mxGraphModel></diagram></mxfile>";
const EMPTY_MODEL = '<mxfile><diagram><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  "</root></mxGraphModel></diagram></mxfile>";

describe("emptyDrawioXml", () => {
  it("새 파일 골격은 mxfile/diagram/기본 레이어 셀을 담는다", () => {
    const xml = emptyDrawioXml();
    expect(xml).toContain("<mxfile");
    expect(xml).toContain("<diagram");
    expect(xml).toContain("<mxGraphModel");
    expect(xml).toContain('<mxCell id="0" />');
    expect(xml).toContain('<mxCell id="1" parent="0" />');
  });

  it("사용자 도형이 없는 빈 다이어그램이라 빈-저장 보호와 충돌하지 않는다", () => {
    const xml = emptyDrawioXml();
    // 새 파일은 isBlankDrawio=true → 빈 채로 닫아도 저장이 허용된다.
    expect(isBlankDrawio(xml)).toBe(true);
    expect(shouldPersistDrawio(xml, xml)).toBe(true);
    // 그러나 일단 내용이 들어가면(시드) 빈 골격으로의 덮어쓰기는 거부된다.
    expect(shouldPersistDrawio(xml, SEEDED)).toBe(false);
  });
});

describe("isBlankDrawio", () => {
  it("treats empty/whitespace/non-string as blank", () => {
    expect(isBlankDrawio("")).toBe(true);
    expect(isBlankDrawio("   \n ")).toBe(true);
    expect(isBlankDrawio(null)).toBe(true);
    expect(isBlankDrawio(undefined)).toBe(true);
  });

  it("treats a default-skeleton model (no user cells) as blank", () => {
    expect(isBlankDrawio(EMPTY_MODEL)).toBe(true);
  });

  it("treats a model with user shapes/edges/objects as non-blank", () => {
    expect(isBlankDrawio(SEEDED)).toBe(false);
    expect(isBlankDrawio('<mxGraphModel><root><mxCell edge="1"/></root></mxGraphModel>')).toBe(false);
    expect(isBlankDrawio("<mxfile><diagram><object label='x'/></diagram></mxfile>")).toBe(false);
  });

  it("treats a compressed <diagram> payload as non-blank", () => {
    expect(isBlankDrawio("<mxfile><diagram>jVNNb9swDP0rgs5x4qTd0KKx0XbY1g==</diagram></mxfile>")).toBe(
      false,
    );
  });
});

describe("shouldPersistDrawio", () => {
  it("refuses to overwrite a non-blank file with a blank diagram", () => {
    expect(shouldPersistDrawio(EMPTY_MODEL, SEEDED)).toBe(false);
    expect(shouldPersistDrawio("", SEEDED)).toBe(false);
  });

  it("allows real edits", () => {
    expect(shouldPersistDrawio(SEEDED, EMPTY_MODEL)).toBe(true);
    expect(shouldPersistDrawio(SEEDED, SEEDED)).toBe(true);
  });

  it("allows a blank save when the file started blank", () => {
    expect(shouldPersistDrawio(EMPTY_MODEL, "")).toBe(true);
    expect(shouldPersistDrawio("", "")).toBe(true);
  });
});

describe("handleEmbedEvent", () => {
  const ctx = { initialXml: "<mxfile>seed</mxfile>" };

  it("loads initial xml with autosave on init", () => {
    expect(handleEmbedEvent({ event: "init" }, ctx)).toEqual({
      reply: { action: "load", autosave: 1, xml: "<mxfile>seed</mxfile>" },
    });
  });

  it("persists xml on autosave", () => {
    expect(handleEmbedEvent({ event: "autosave", xml: "<mxfile>edited</mxfile>" }, ctx)).toEqual({
      saveXml: "<mxfile>edited</mxfile>",
    });
  });

  it("persists and exits on save-and-exit", () => {
    expect(
      handleEmbedEvent({ event: "save", xml: "<mxfile>final</mxfile>", exit: true }, ctx),
    ).toEqual({ saveXml: "<mxfile>final</mxfile>", exit: true });
  });

  it("exits on exit event", () => {
    expect(handleEmbedEvent({ event: "exit" }, ctx)).toEqual({ exit: true });
  });

  it("ignores unknown/malformed messages", () => {
    expect(handleEmbedEvent({ event: "noop" }, ctx)).toBeNull();
    expect(handleEmbedEvent(null, ctx)).toBeNull();
    expect(handleEmbedEvent("not-an-object", ctx)).toBeNull();
    expect(handleEmbedEvent({ event: "autosave" }, ctx)).toBeNull();
  });
});
