import { describe, expect, it } from "vitest";
import { buildEditorUrl, handleEmbedEvent } from "./drawioEmbed";

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

  it("adds dark and lang only when requested", () => {
    const plain = new URL(buildEditorUrl({ basePath: "a" }), "http://x/").searchParams;
    expect(plain.get("dark")).toBeNull();
    expect(plain.get("lang")).toBeNull();

    const themed = new URL(
      buildEditorUrl({ basePath: "a", dark: true, lang: "ko" }),
      "http://x/",
    ).searchParams;
    expect(themed.get("dark")).toBe("1");
    expect(themed.get("lang")).toBe("ko");
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
