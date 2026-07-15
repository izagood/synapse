import type { TranslationKey } from "../../i18n";
import { shortcutLabel, type DesktopPlatform } from "../../shared/platform";
import type { ShortcutCategory, ShortcutDef } from "../../shared/shortcuts";

// 치트시트에 카테고리를 노출하는 순서
export const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "navigation",
  "file",
  "view",
  "editor",
];

/**
 * 현재 플랫폼에서 유효한 단축키만 남긴다 (platforms 미지정=전체).
 * cheatsheetMerge:"hidden" 항목(tab.goTo2~9)은 치트시트에 표시하지 않는다 —
 * 대표 항목(goTo1)이 mergedKeyLabel 로 ⌘1…9 범위를 표시한다.
 */
export function visibleShortcuts(
  defs: ShortcutDef[],
  platform: DesktopPlatform,
): ShortcutDef[] {
  return defs.filter(
    (d) => (!d.platforms || d.platforms.includes(platform)) && d.cheatsheetMerge !== "hidden",
  );
}

/** 키 라벨 — cheatsheetMerge:"first" 항목은 ⌘1…9 처럼 범위로 표시 */
export function mergedKeyLabel(def: ShortcutDef, platform: DesktopPlatform): string {
  const label = shortcutLabel(def.keys, platform);
  return def.cheatsheetMerge === "first" ? `${label}…9` : label;
}

/**
 * 검색어로 단축키를 거른다. 번역된 설명과 키 라벨(⌘P 등) 양쪽에
 * 부분 문자열 매칭한다. 빈 쿼리는 전체를 반환한다.
 * translate 를 주입받아 순수 함수로 유지한다(테스트 용이).
 */
export function filterShortcuts(
  defs: ShortcutDef[],
  query: string,
  translate: (key: TranslationKey) => string,
  platform: DesktopPlatform,
): ShortcutDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return defs;
  return defs.filter((d) => {
    const desc = translate(d.descriptionKey).toLowerCase();
    const label = shortcutLabel(d.keys, platform).toLowerCase();
    return desc.includes(q) || label.includes(q);
  });
}

export interface ShortcutGroup {
  category: ShortcutCategory;
  items: ShortcutDef[];
}

/** 카테고리별로 묶는다. CATEGORY_ORDER 순서를 따르고 빈 그룹은 제외한다. */
export function groupByCategory(defs: ShortcutDef[]): ShortcutGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: defs.filter((d) => d.category === category),
  })).filter((g) => g.items.length > 0);
}
