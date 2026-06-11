import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import { DEFAULT_SETTINGS, type Settings } from "../ipc/types";

function normalizeSettings(settings: Settings): Settings {
  const language = settings.appearance.language === "en" ? "en" : "ko";
  return {
    ...settings,
    appearance: { ...settings.appearance, language },
  };
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  showSettings: boolean;

  init(): Promise<void>;
  /** 일부 섹션만 갱신해도 전체를 병합·저장한다 */
  update(patch: Partial<Settings>): Promise<void>;
  openSettings(): void;
  closeSettings(): void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  showSettings: false,

  async init() {
    try {
      set({ settings: normalizeSettings(await ipc.getSettings()), loaded: true });
    } catch {
      set({ loaded: true }); // 설정을 못 읽어도 기본값으로 동작
    }
  },

  async update(patch) {
    const merged: Settings = normalizeSettings({
      ...get().settings,
      ...patch,
      appearance: { ...get().settings.appearance, ...patch.appearance },
      editor: { ...get().settings.editor, ...patch.editor },
      sync: { ...get().settings.sync, ...patch.sync },
      htmlViewer: { ...get().settings.htmlViewer, ...patch.htmlViewer },
      files: { ...get().settings.files, ...patch.files },
    });
    set({ settings: merged });
    await ipc.updateSettings(merged);
  },

  openSettings() {
    set({ showSettings: true });
  },
  closeSettings() {
    set({ showSettings: false });
  },
}));

/** appearance.theme + OS 선호를 합쳐 실제 테마를 계산한다 */
export function effectiveTheme(theme: Settings["appearance"]["theme"]): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window !== "undefined" && "matchMedia" in window) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}
