import { describe, expect, it } from "vitest";
import { translate, type TranslationKey } from "../../i18n";
import type { ShortcutDef } from "../../shared/shortcuts";
import { SHORTCUTS } from "../../shared/shortcuts";
import { filterShortcuts, groupByCategory, visibleShortcuts } from "./cheatsheet";

const en = (key: TranslationKey) => translate("en", key);

describe("visibleShortcuts", () => {
  const defs: ShortcutDef[] = [
    {
      id: "a",
      category: "general",
      keys: ["Mod", "A"],
      descriptionKey: "shortcuts.desc.save",
      handledBy: "app",
    },
    {
      id: "mac-only",
      category: "general",
      keys: ["Mod", "B"],
      descriptionKey: "shortcuts.desc.save",
      handledBy: "app",
      platforms: ["macos"],
    },
  ];

  it("keeps platform-agnostic entries and drops those not for the platform", () => {
    expect(visibleShortcuts(defs, "windows").map((d) => d.id)).toEqual(["a"]);
    expect(visibleShortcuts(defs, "macos").map((d) => d.id)).toEqual(["a", "mac-only"]);
  });
});

describe("filterShortcuts", () => {
  it("returns everything for an empty query", () => {
    expect(filterShortcuts(SHORTCUTS, "", en, "macos")).toHaveLength(SHORTCUTS.length);
    expect(filterShortcuts(SHORTCUTS, "   ", en, "macos")).toHaveLength(SHORTCUTS.length);
  });

  it("matches the translated description, case-insensitively", () => {
    const out = filterShortcuts(SHORTCUTS, "SAVE", en, "macos");
    expect(out.map((d) => d.id)).toContain("file.save");
    expect(out.every((d) => d.id !== "view.graph")).toBe(true);
  });

  it("matches the platform key label", () => {
    // windows 라벨은 "Ctrl+..." 이므로 "ctrl" 검색이 전부 매칭된다
    const ctrl = filterShortcuts(SHORTCUTS, "ctrl", en, "windows");
    expect(ctrl.length).toBeGreaterThan(0);
    // macOS 에는 "Ctrl" 문자열이 없어 라벨 매칭이 없다(설명에 ctrl 없음)
    expect(filterShortcuts(SHORTCUTS, "ctrl", en, "macos")).toHaveLength(0);
  });
});

describe("groupByCategory", () => {
  it("groups in category order and omits empty groups", () => {
    const groups = groupByCategory(SHORTCUTS);
    expect(groups.map((g) => g.category)).toEqual([
      "general",
      "navigation",
      "file",
      "view",
      "editor",
    ]);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(SHORTCUTS.length);
  });

  it("drops categories with no items", () => {
    const onlyGeneral = SHORTCUTS.filter((d) => d.category === "general");
    expect(groupByCategory(onlyGeneral).map((g) => g.category)).toEqual(["general"]);
  });
});
