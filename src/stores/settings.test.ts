import { beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "./settings";
import { ipc } from "../ipc/ipc";
import { DEFAULT_SETTINGS } from "../ipc/types";

describe("settings store (mock ipc)", () => {
  beforeEach(async () => {
    await ipc.updateSettings(structuredClone(DEFAULT_SETTINGS));
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: false,
      showSettings: false,
    });
  });

  it("loads settings on init", async () => {
    await useSettings.getState().init();
    const s = useSettings.getState();
    expect(s.loaded).toBe(true);
    expect(s.settings.appearance.theme).toBe("system");
  });

  it("partial update merges sections and persists", async () => {
    await useSettings.getState().update({
      appearance: { theme: "dark", language: "ko" },
    });
    // 다른 섹션은 그대로
    expect(useSettings.getState().settings.editor.fontSize).toBe(16);

    // 저장되어 다시 읽어도 유지
    const persisted = await ipc.getSettings();
    expect(persisted.appearance.theme).toBe("dark");
    expect(persisted.sync.auto).toBe(true);
  });

  it("nested patch only touches given fields", async () => {
    await useSettings.getState().update({
      editor: { ...useSettings.getState().settings.editor, fontSize: 20 },
    });
    const s = useSettings.getState().settings;
    expect(s.editor.fontSize).toBe(20);
    expect(s.editor.autoSaveDelayMs).toBe(1000);
  });
});
