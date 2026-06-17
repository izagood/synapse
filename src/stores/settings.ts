import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import { DEFAULT_SETTINGS, type Settings } from "../ipc/types";
import { effectiveBaseTheme } from "../features/theme/theme";

function normalizeSettings(settings: Settings): Settings {
  const language = settings.appearance.language === "en" ? "en" : "ko";
  return {
    ...settings,
    appearance: {
      ...settings.appearance,
      language,
      // 과거 설정 파일에는 customColors가 없을 수 있어 항상 객체로 보정한다
      customColors: settings.appearance.customColors ?? {},
    },
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
      agent: { ...get().settings.agent, ...patch.agent },
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

/**
 * appearance.theme + OS 선호를 light/dark 둘 중 하나로 환원한다.
 * Excalidraw처럼 light/dark만 받는 곳에서 쓴다 (pink는 밝은 계열 → light).
 */
export function effectiveTheme(theme: Settings["appearance"]["theme"]): "light" | "dark" {
  return effectiveBaseTheme(theme) === "dark" ? "dark" : "light";
}
