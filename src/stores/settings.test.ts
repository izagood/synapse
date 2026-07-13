import { beforeEach, describe, expect, it } from "vitest";
import { useSettings, effectiveCanvasTheme } from "./settings";
import { ipc } from "../ipc/ipc";
import { DEFAULT_SETTINGS, type Settings } from "../ipc/types";

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
      appearance: { theme: "dark", language: "ko", customColors: {}, canvasTheme: "light" },
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
        canvasTheme: "light",
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

  it("normalizes unsupported language values to Korean", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        appearance: {
          theme: "system",
          language: "fr" as "ko",
          customColors: {},
          canvasTheme: "light",
        },
      },
    });

    await useSettings.getState().update({ sync: { auto: false, intervalMinutes: 5 } });

    expect(useSettings.getState().settings.appearance.language).toBe("ko");
  });

  it("과거 설정의 누락된 canvasTheme를 light로 보정한다", async () => {
    // canvasTheme 필드가 없던 시절의 설정을 흉내낸다 (필드 누락 → 캐스팅).
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        appearance: {
          theme: "dark",
          language: "ko",
          customColors: {},
        } as Settings["appearance"],
      },
    });

    // normalizeSettings를 타는 아무 update나 호출하면 보정된다.
    await useSettings.getState().update({ sync: { auto: false, intervalMinutes: 5 } });

    expect(useSettings.getState().settings.appearance.canvasTheme).toBe("light");
  });

  it("terminal 기본값이 로드된다", async () => {
    await useSettings.getState().init();
    expect(useSettings.getState().settings.terminal).toEqual({
      external: "terminal",
      customCommand: "",
    });
  });

  it("terminal.external 갱신이 다른 섹션을 건드리지 않고 저장된다", async () => {
    await useSettings.getState().update({
      terminal: { external: "iterm2", customCommand: "" },
    });

    const s = useSettings.getState().settings;
    expect(s.terminal.external).toBe("iterm2");
    expect(s.editor.fontSize).toBe(16);

    const persisted = await ipc.getSettings();
    expect(persisted.terminal.external).toBe("iterm2");
  });

  it("과거 설정의 누락된 terminal 섹션을 기본값으로 보정한다", async () => {
    // terminal 섹션이 없던 시절의 설정 파일을 흉내낸다 (필드 누락 → 캐스팅).
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<Settings>;
    delete legacy.terminal;
    await ipc.updateSettings(legacy as Settings);

    // init()이 normalizeSettings를 태워 과거 설정을 읽어들인다.
    await useSettings.getState().init();

    expect(useSettings.getState().settings.terminal).toEqual(DEFAULT_SETTINGS.terminal);
  });

});

describe("effectiveCanvasTheme", () => {
  const base = (over: Partial<Settings["appearance"]>): Settings["appearance"] => ({
    theme: "system",
    language: "ko",
    customColors: {},
    canvasTheme: "light",
    ...over,
  });

  it("light/dark 고정은 앱 테마와 무관하게 그대로 쓴다", () => {
    // 앱은 다크인데 캔버스는 라이트 — 이 기능의 핵심 동작.
    expect(effectiveCanvasTheme(base({ theme: "dark", canvasTheme: "light" }))).toBe("light");
    expect(effectiveCanvasTheme(base({ theme: "light", canvasTheme: "dark" }))).toBe("dark");
  });

  it("auto는 앱 테마를 따른다", () => {
    expect(effectiveCanvasTheme(base({ theme: "dark", canvasTheme: "auto" }))).toBe("dark");
    expect(effectiveCanvasTheme(base({ theme: "light", canvasTheme: "auto" }))).toBe("light");
    // pink는 밝은 계열 → light (effectiveTheme 위임)
    expect(effectiveCanvasTheme(base({ theme: "pink", canvasTheme: "auto" }))).toBe("light");
  });
});
