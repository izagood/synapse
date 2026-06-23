import { describe, expect, it } from "vitest";
import { flattenKeys, localeDictionaries } from "../i18n";
import {
  isShortcut,
  mainKeyTokens,
  matchShortcut,
  SHORTCUTS,
  shortcutById,
  type KeyEventLike,
} from "./shortcuts";

function ev(part: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...part,
  };
}

describe("matchShortcut", () => {
  it("matches Mod via either metaKey(⌘) or ctrlKey", () => {
    expect(matchShortcut(ev({ key: "s", metaKey: true }), ["Mod", "S"])).toBe(true);
    expect(matchShortcut(ev({ key: "s", ctrlKey: true }), ["Mod", "S"])).toBe(true);
  });

  it("ignores main key case", () => {
    expect(matchShortcut(ev({ key: "S", metaKey: true }), ["Mod", "S"])).toBe(true);
  });

  it("requires every modifier to match exactly", () => {
    // Shift 가 필요한데 안 눌림
    expect(matchShortcut(ev({ key: "a", metaKey: true }), ["Mod", "Shift", "A"])).toBe(false);
    // Shift 가 필요 없는데 눌림
    expect(matchShortcut(ev({ key: "s", metaKey: true, shiftKey: true }), ["Mod", "S"])).toBe(
      false,
    );
    // Mod 가 필요 없는데 눌림
    expect(matchShortcut(ev({ key: "s" }), ["S"])).toBe(true);
    expect(matchShortcut(ev({ key: "s", metaKey: true }), ["S"])).toBe(false);
  });

  it("matches the full Mod+Shift combo", () => {
    expect(
      matchShortcut(ev({ key: "a", metaKey: true, shiftKey: true }), ["Mod", "Shift", "A"]),
    ).toBe(true);
    expect(
      matchShortcut(ev({ key: "n", ctrlKey: true, shiftKey: true }), ["Mod", "Shift", "N"]),
    ).toBe(true);
  });

  it("matches punctuation keys", () => {
    expect(matchShortcut(ev({ key: ",", metaKey: true }), ["Mod", ","])).toBe(true);
    expect(matchShortcut(ev({ key: "/", ctrlKey: true }), ["Mod", "/"])).toBe(true);
  });

  it("returns false when there is no single main key", () => {
    expect(matchShortcut(ev({ key: "Control", ctrlKey: true }), ["Mod"])).toBe(false);
  });
});

describe("isShortcut + shortcutById", () => {
  it("resolves a registry entry and matches its keys", () => {
    expect(isShortcut(ev({ key: "s", metaKey: true }), "file.save")).toBe(true);
    expect(isShortcut(ev({ key: "p", ctrlKey: true }), "nav.quickOpen")).toBe(true);
  });

  it("throws for unknown ids", () => {
    expect(() => shortcutById("does.not.exist")).toThrow();
  });

  it("maps ⌘W / Ctrl+W to tab.close (and only that combo)", () => {
    expect(isShortcut(ev({ key: "w", metaKey: true }), "tab.close")).toBe(true);
    expect(isShortcut(ev({ key: "w", ctrlKey: true }), "tab.close")).toBe(true);
    // 수식키 없는 W, 또는 Shift 가 섞이면 탭 닫기가 아니다
    expect(isShortcut(ev({ key: "w" }), "tab.close")).toBe(false);
    expect(isShortcut(ev({ key: "w", metaKey: true, shiftKey: true }), "tab.close")).toBe(false);
  });
});

describe("SHORTCUTS registry integrity", () => {
  it("has unique ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each entry has exactly one main key and non-empty keys", () => {
    for (const def of SHORTCUTS) {
      expect(def.keys.length).toBeGreaterThan(0);
      expect(mainKeyTokens(def.keys)).toHaveLength(1);
    }
  });

  it("every descriptionKey exists in the ko translation tree", () => {
    const known = new Set(flattenKeys(localeDictionaries.ko));
    for (const def of SHORTCUTS) {
      expect(known.has(def.descriptionKey)).toBe(true);
    }
  });
});
