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

describe("생성 단축키", () => {
  it("⌘N / Ctrl+N = 새 노트 (Shift 가 섞이면 새 창이지 새 노트가 아니다)", () => {
    expect(isShortcut(ev({ key: "n", metaKey: true }), "file.newNote")).toBe(true);
    expect(isShortcut(ev({ key: "n", ctrlKey: true }), "file.newNote")).toBe(true);
    expect(isShortcut(ev({ key: "n", metaKey: true, shiftKey: true }), "file.newNote")).toBe(false);
  });

  it("⌘⇧D = 새 드로잉 (Shift 없으면 매칭 안 됨)", () => {
    expect(
      isShortcut(ev({ key: "d", metaKey: true, shiftKey: true }), "file.newDrawing"),
    ).toBe(true);
    expect(isShortcut(ev({ key: "d", metaKey: true }), "file.newDrawing")).toBe(false);
  });

  it("⌘⇧M = 새 다이어그램", () => {
    expect(
      isShortcut(ev({ key: "m", metaKey: true, shiftKey: true }), "file.newDiagram"),
    ).toBe(true);
  });
});

describe("Ctrl 토큰 (ctrlKey 단독 — mac ⌃Tab 등)", () => {
  it("Ctrl+Tab은 ctrlKey만 눌렸을 때 매칭된다", () => {
    expect(matchShortcut(ev({ key: "Tab", ctrlKey: true }), ["Ctrl", "Tab"])).toBe(true);
  });

  it("⌘Tab(metaKey)은 Ctrl 토큰에 매칭되지 않는다", () => {
    expect(matchShortcut(ev({ key: "Tab", metaKey: true }), ["Ctrl", "Tab"])).toBe(false);
  });

  it("Ctrl+meta 동시 입력은 Ctrl 토큰에 매칭되지 않는다", () => {
    expect(
      matchShortcut(ev({ key: "Tab", ctrlKey: true, metaKey: true }), ["Ctrl", "Tab"]),
    ).toBe(false);
  });

  it("Ctrl+Shift+Tab은 Shift 유무를 정확히 요구한다", () => {
    expect(
      matchShortcut(ev({ key: "Tab", ctrlKey: true, shiftKey: true }), ["Ctrl", "Shift", "Tab"]),
    ).toBe(true);
    expect(matchShortcut(ev({ key: "Tab", ctrlKey: true }), ["Ctrl", "Shift", "Tab"])).toBe(false);
  });
});

describe("신규 단축키 정의 (커맨드 시스템)", () => {
  it("신규 id들이 존재하고 키가 스펙과 일치한다", () => {
    expect(shortcutById("palette.toggle").keys).toEqual(["Mod", "Shift", "P"]);
    expect(shortcutById("tab.next").keys).toEqual(["Ctrl", "Tab"]);
    expect(shortcutById("tab.prev").keys).toEqual(["Ctrl", "Shift", "Tab"]);
    expect(shortcutById("tab.closeOthers").keys).toEqual(["Mod", "Alt", "T"]);
    expect(shortcutById("tab.reopen").keys).toEqual(["Mod", "Shift", "T"]);
    for (let n = 1; n <= 9; n++) {
      expect(shortcutById(`tab.goTo${n}`).keys).toEqual(["Mod", String(n)]);
    }
  });

  it("goTo 시리즈는 치트시트 병합 표시 플래그를 가진다", () => {
    expect(shortcutById("tab.goTo1").cheatsheetMerge).toBe("first");
    expect(shortcutById("tab.goTo2").cheatsheetMerge).toBe("hidden");
    expect(shortcutById("tab.goTo9").cheatsheetMerge).toBe("hidden");
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
