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
      // 과거 설정에는 canvasTheme가 없다 → 기본 light(캔버스는 밝게)로 보정한다
      canvasTheme: settings.appearance.canvasTheme ?? "light",
    },
  };
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  showSettings: boolean;
  showShortcuts: boolean;

  init(): Promise<void>;
  /** 일부 섹션만 갱신해도 전체를 병합·저장한다 */
  update(patch: Partial<Settings>): Promise<void>;
  openSettings(): void;
  closeSettings(): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  toggleShortcuts(): void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  showSettings: false,
  showShortcuts: false,

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
  openShortcuts() {
    set({ showShortcuts: true });
  },
  closeShortcuts() {
    set({ showShortcuts: false });
  },
  toggleShortcuts() {
    set((s) => ({ showShortcuts: !s.showShortcuts }));
  },
}));

/**
 * appearance.theme + OS 선호를 light/dark 둘 중 하나로 환원한다.
 * Excalidraw처럼 light/dark만 받는 곳에서 쓴다 (pink는 밝은 계열 → light).
 */
export function effectiveTheme(theme: Settings["appearance"]["theme"]): "light" | "dark" {
  return effectiveBaseTheme(theme) === "dark" ? "dark" : "light";
}

/**
 * 캔버스 도구(excalidraw)에 적용할 light/dark를 정한다. canvasTheme가 명시 고정이면
 * 그대로, "auto"면 앱 테마(effectiveTheme)를 따른다. drawio는 이 함수를 쓰지 않는다.
 */
export function effectiveCanvasTheme(
  appearance: Settings["appearance"],
): "light" | "dark" {
  const c = appearance.canvasTheme;
  if (c === "light" || c === "dark") return c;
  return effectiveTheme(appearance.theme);
}
