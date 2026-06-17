// 테마 적용 로직 (GUI/Tauri 비의존 순수 함수). UI는 이 함수들만 호출한다.
import {
  CUSTOM_COLOR_KEYS,
  type CustomColorKey,
  type CustomColors,
  type ThemeSetting,
} from "../../ipc/types";

/** "system"을 제외한, 실제 화면에 그려지는 프리셋 테마 */
export type BaseTheme = "light" | "dark" | "pink";

/** 커스텀 색상 키 → 덮어쓸 CSS 변수 이름 */
export const CSS_VAR_BY_KEY: Record<CustomColorKey, string> = {
  accent: "--accent",
  bg: "--bg",
  bgPanel: "--bg-panel",
  bgRail: "--bg-rail",
  fg: "--fg",
  fgDim: "--fg-dim",
  border: "--border",
};

// 컬러 피커 초기값으로 쓰는 각 프리셋의 대표 색(styles.css와 동일하게 유지).
// 실제 렌더링은 styles.css가 담당하고, 여기 값은 "편집 시작점"으로만 쓴다.
export const PRESET_PALETTES: Record<BaseTheme, Record<CustomColorKey, string>> = {
  dark: {
    accent: "#7c6cf0",
    bg: "#1e1e1e",
    bgPanel: "#252526",
    bgRail: "#1b1b1c",
    fg: "#d8d8dc",
    fgDim: "#9a9aa3",
    border: "#333338",
  },
  light: {
    accent: "#5b4ee0",
    bg: "#ffffff",
    bgPanel: "#f5f5f7",
    bgRail: "#ececef",
    fg: "#25252a",
    fgDim: "#6e6f78",
    border: "#dddde3",
  },
  pink: {
    accent: "#d14a8f",
    bg: "#fff5f8",
    bgPanel: "#ffe9f0",
    bgRail: "#ffdde9",
    fg: "#4d1f33",
    fgDim: "#8a5a6e",
    border: "#f2c2d5",
  },
};

/** appearance.theme + OS 선호를 합쳐 실제로 그릴 프리셋 테마를 계산한다 */
export function effectiveBaseTheme(theme: ThemeSetting): BaseTheme {
  if (theme !== "system") return theme;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

/** 네이티브 창(타이틀바)이 따를 테마. pink는 밝은 계열이라 light로 본다. */
export function nativeWindowTheme(theme: ThemeSetting): "light" | "dark" | null {
  if (theme === "system") return null;
  return effectiveBaseTheme(theme) === "dark" ? "dark" : "light";
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** type="color" 입력이 만들어내는 형태(#rgb/#rrggbb)인지 검사 */
export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

/** #rrggbb(또는 #rgb)을 rgba(...) 문자열로. accent-soft 파생에 쓴다. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * data-theme 속성으로 프리셋을 고르고, 커스텀 색상을 인라인 CSS 변수로 덮어쓴다.
 * 인라인 변수는 styles.css 규칙보다 우선하므로 어떤 프리셋 위에도 얹힌다.
 * 이전에 얹은 오버라이드는 항상 먼저 지워 토글/초기화가 깨끗하게 동작한다.
 */
export function applyTheme(
  root: HTMLElement,
  theme: ThemeSetting,
  customColors: CustomColors = {},
): void {
  root.setAttribute("data-theme", effectiveBaseTheme(theme));

  for (const key of CUSTOM_COLOR_KEYS) {
    root.style.removeProperty(CSS_VAR_BY_KEY[key]);
  }
  root.style.removeProperty("--accent-soft");

  for (const key of CUSTOM_COLOR_KEYS) {
    const value = customColors[key];
    if (value && isHexColor(value)) {
      root.style.setProperty(CSS_VAR_BY_KEY[key], value);
      // accent를 바꾸면 그에 맞춰 옅은 강조색도 같이 파생시킨다
      if (key === "accent") {
        root.style.setProperty("--accent-soft", hexToRgba(value, 0.18));
      }
    }
  }
}
