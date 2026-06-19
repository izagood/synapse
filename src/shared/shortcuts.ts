import type { TranslationKey } from "../i18n";
import type { DesktopPlatform } from "./platform";

// 단축키 시스템의 단일 출처(single source of truth).
// 흩어져 있던 keydown 핸들러들이 여기 정의된 keys 를 참조하고,
// 치트시트 모달도 같은 정의를 읽어 표시한다. keys 한 곳만 고치면
// 동작과 표시가 동시에 바뀐다.

export type ShortcutCategory = "general" | "navigation" | "file" | "view" | "editor";

// handledBy 로 "우리 JS keydown 이 처리하는 단축키(app)"와
// "에디터(tiptap/MarkdownEditor)가 처리하는 표시 전용 단축키(editor)"를 구분한다.
// editor 항목은 전역 핸들러의 디스패치 대상이 아니며 치트시트에 표시만 된다.
export type ShortcutHandledBy = "app" | "editor";

export interface ShortcutDef {
  /** 안정 식별자. 예: "file.save" */
  id: string;
  category: ShortcutCategory;
  /** shortcutLabel 과 동일한 토큰 배열. 예: ["Mod", "Shift", "N"] */
  keys: string[];
  /** i18n 설명 키 (오타 시 typecheck 에서 잡힌다) */
  descriptionKey: TranslationKey;
  handledBy: ShortcutHandledBy;
  /** 생략 시 전체 플랫폼. 특정 플랫폼 전용일 때만 지정 */
  platforms?: DesktopPlatform[];
}

const MODIFIER_TOKENS = new Set(["Mod", "Shift", "Alt"]);

/** keys 에서 modifier 가 아닌 메인 키 토큰들 */
export function mainKeyTokens(keys: string[]): string[] {
  return keys.filter((k) => !MODIFIER_TOKENS.has(k));
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 키 이벤트가 주어진 단축키 정의(keys)와 일치하는지 순수 판정한다.
 * "Mod" = metaKey(⌘) 또는 ctrlKey, "Shift" = shiftKey, "Alt" = altKey.
 * 메인 키는 e.key 를 소문자 비교한다. 기존 핸들러들의
 * (ctrlKey||metaKey) + key.toLowerCase() 비교와 동치다.
 */
export function matchShortcut(e: KeyEventLike, keys: string[]): boolean {
  const main = mainKeyTokens(keys);
  if (main.length !== 1) return false;
  const wantMod = keys.includes("Mod");
  const wantShift = keys.includes("Shift");
  const wantAlt = keys.includes("Alt");
  const mod = e.metaKey || e.ctrlKey;
  if (wantMod !== mod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  return e.key.toLowerCase() === main[0].toLowerCase();
}

export const SHORTCUTS: ShortcutDef[] = [
  // --- 일반 (전역) ---
  {
    id: "settings.toggle",
    category: "general",
    keys: ["Mod", ","],
    descriptionKey: "shortcuts.desc.settingsToggle",
    handledBy: "app",
  },
  {
    id: "window.new",
    category: "general",
    keys: ["Mod", "Shift", "N"],
    descriptionKey: "shortcuts.desc.newWindow",
    handledBy: "app",
  },
  {
    id: "help.cheatsheet",
    category: "general",
    keys: ["Mod", "/"],
    descriptionKey: "shortcuts.desc.cheatsheet",
    handledBy: "app",
  },
  // --- 탐색 ---
  {
    id: "nav.quickOpen",
    category: "navigation",
    keys: ["Mod", "P"],
    descriptionKey: "shortcuts.desc.quickOpen",
    handledBy: "app",
  },
  {
    id: "nav.search",
    category: "navigation",
    keys: ["Mod", "Shift", "F"],
    descriptionKey: "shortcuts.desc.search",
    handledBy: "app",
  },
  // --- 파일 ---
  {
    id: "file.save",
    category: "file",
    keys: ["Mod", "S"],
    descriptionKey: "shortcuts.desc.save",
    handledBy: "app",
  },
  {
    id: "file.delete",
    category: "file",
    keys: ["Mod", "Backspace"],
    descriptionKey: "shortcuts.desc.deleteFile",
    handledBy: "app",
  },
  // --- 보기 ---
  {
    id: "view.toggleSidebar",
    category: "view",
    keys: ["Mod", "B"],
    descriptionKey: "shortcuts.desc.toggleSidebar",
    handledBy: "app",
  },
  {
    id: "view.toggleAgent",
    category: "view",
    keys: ["Mod", "Shift", "A"],
    descriptionKey: "shortcuts.desc.toggleAgent",
    handledBy: "app",
  },
  {
    id: "view.graph",
    category: "view",
    keys: ["Mod", "Shift", "G"],
    descriptionKey: "shortcuts.desc.graph",
    handledBy: "app",
  },
  // --- 편집 (에디터 포커스 시 동작 · 표시 전용) ---
  {
    id: "editor.find",
    category: "editor",
    keys: ["Mod", "F"],
    descriptionKey: "shortcuts.desc.find",
    handledBy: "editor",
  },
  {
    id: "editor.bold",
    category: "editor",
    keys: ["Mod", "B"],
    descriptionKey: "shortcuts.desc.bold",
    handledBy: "editor",
  },
  {
    id: "editor.italic",
    category: "editor",
    keys: ["Mod", "I"],
    descriptionKey: "shortcuts.desc.italic",
    handledBy: "editor",
  },
  {
    id: "editor.code",
    category: "editor",
    keys: ["Mod", "E"],
    descriptionKey: "shortcuts.desc.code",
    handledBy: "editor",
  },
  {
    id: "editor.strike",
    category: "editor",
    keys: ["Mod", "Shift", "S"],
    descriptionKey: "shortcuts.desc.strike",
    handledBy: "editor",
  },
  {
    id: "editor.undo",
    category: "editor",
    keys: ["Mod", "Z"],
    descriptionKey: "shortcuts.desc.undo",
    handledBy: "editor",
  },
  {
    id: "editor.redo",
    category: "editor",
    keys: ["Mod", "Shift", "Z"],
    descriptionKey: "shortcuts.desc.redo",
    handledBy: "editor",
  },
];

/** id 로 단축키 정의를 찾는다. 없으면 개발 오류이므로 throw 한다. */
export function shortcutById(id: string): ShortcutDef {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown shortcut id: ${id}`);
  return def;
}

/** id 의 keys 가 이벤트와 일치하는지 — 핸들러에서 쓰는 단축 헬퍼 */
export function isShortcut(e: KeyEventLike, id: string): boolean {
  return matchShortcut(e, shortcutById(id).keys);
}
