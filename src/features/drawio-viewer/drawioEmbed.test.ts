import { describe, expect, it } from "vitest";
import {
  buildEditorUrl,
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

  it("never enables drawio dark mode (always light canvas)", () => {
    const plain = new URL(buildEditorUrl({ basePath: "a" }), "http://x/").searchParams;
    expect(plain.get("dark")).toBeNull();
    const withLang = new URL(buildEditorUrl({ basePath: "a", lang: "ko" }), "http://x/").searchParams;
    expect(withLang.get("dark")).toBeNull();
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
