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
      appearance: { theme: "dark", language: "ko", customColors: {} },
    });
    // 다른 섹션은 그대로
    expect(useSettings.getState().settings.editor.fontSize).toBe(16);

    // 저장되어 다시 읽어도 유지
    const persisted = await ipc.getSettings();
    expect(persisted.appearance.theme).toBe("dark");
    expect(persisted.sync.auto).toBe(true);
  });

  it("pink 테마와 커스텀 색상이 저장·복원된다", async () => {
    await useSettings.getState().update({
      appearance: {
        theme: "pink",
        language: "ko",
        customColors: { accent: "#ff66aa" },
      },
    });

    const persisted = await ipc.getSettings();
    expect(persisted.appearance.theme).toBe("pink");
    expect(persisted.appearance.customColors.accent).toBe("#ff66aa");
  });

  it("files.confirmDelete 갱신이 다른 섹션을 건드리지 않고 저장된다", async () => {
    expect(useSettings.getState().settings.files.confirmDelete).toBe(true);
    await useSettings.getState().update({ files: { confirmDelete: false } });

    const s = useSettings.getState().settings;
    expect(s.files.confirmDelete).toBe(false);
    expect(s.editor.fontSize).toBe(16);

    const persisted = await ipc.getSettings();
    expect(persisted.files.confirmDelete).toBe(false);
  });

  it("nested patch only touches given fields", async () => {
    await useSettings.getState().update({
      editor: { ...useSettings.getState().settings.editor, fontSize: 20 },
    });
    const s = useSettings.getState().settings;
    expect(s.editor.fontSize).toBe(20);
    expect(s.editor.autoSaveDelayMs).toBe(1000);
  });

  it("showLineNumbers 기본값은 false이고 토글이 저장·복원된다", async () => {
    expect(useSettings.getState().settings.editor.showLineNumbers).toBe(false);
    await useSettings.getState().update({
      editor: { ...useSettings.getState().settings.editor, showLineNumbers: true },
    });
    const s = useSettings.getState().settings;
    expect(s.editor.showLineNumbers).toBe(true);
    expect(s.editor.fontSize).toBe(16); // 다른 필드 보존

    const persisted = await ipc.getSettings();
    expect(persisted.editor.showLineNumbers).toBe(true);
  });

  it("normalizes unsupported language values to Korean", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        appearance: { theme: "system", language: "fr" as "ko", customColors: {} },
      },
    });

    await useSettings.getState().update({ sync: { auto: false, intervalMinutes: 5 } });

    expect(useSettings.getState().settings.appearance.language).toBe("ko");
  });

  it("defaults agent auth mode to subscription", async () => {
    await useSettings.getState().init();
    const agent = useSettings.getState().settings.agent;
    expect(agent.authMode).toBe("subscription");
    expect(agent.model).toBe("");
    expect(agent.permissionMode).toBe("");
  });

  it("agent 섹션 갱신이 다른 섹션을 건드리지 않고 저장된다", async () => {
    await useSettings.getState().update({
      agent: {
        ...useSettings.getState().settings.agent,
        authMode: "apiKey",
        model: "claude-sonnet-4-5",
      },
    });

    const s = useSettings.getState().settings;
    expect(s.agent.authMode).toBe("apiKey");
    expect(s.agent.model).toBe("claude-sonnet-4-5");
    expect(s.agent.permissionMode).toBe(""); // 지정 안 한 필드는 기존값 유지
    expect(s.editor.fontSize).toBe(16); // 다른 섹션 불변

    const persisted = await ipc.getSettings();
    expect(persisted.agent.authMode).toBe("apiKey");
    expect(persisted.agent.model).toBe("claude-sonnet-4-5");
  });
});
