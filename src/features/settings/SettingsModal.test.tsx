// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_SETTINGS } from "../../ipc/types";
import { useSettings } from "../../stores/settings";
import { SettingsModal } from "./SettingsModal";

let root: Root | null = null;
let host: HTMLDivElement;

function render() {
  root = createRoot(host);
  act(() => {
    root!.render(<SettingsModal />);
  });
}

describe("SettingsModal i18n", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: true,
      showSettings: true,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it("renders Korean by default and switches to English immediately", async () => {
    render();

    expect(host.textContent).toContain("설정");
    expect(host.textContent).toContain("언어");

    const selects = Array.from(host.querySelectorAll("select"));
    const languageSelect = selects.find((select) => select.value === "ko");
    expect(languageSelect).toBeTruthy();

    await act(async () => {
      languageSelect!.value = "en";
      languageSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useSettings.getState().settings.appearance.language).toBe("en");
    expect(host.textContent).toContain("Settings");
    expect(host.textContent).toContain("Language");
    expect(host.textContent).toContain("Appearance");
  });

  it("opens the shortcut cheatsheet from the settings button and closes settings", async () => {
    render();

    const button = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("단축키 보기"),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useSettings.getState().showShortcuts).toBe(true);
    expect(useSettings.getState().showSettings).toBe(false);
  });

  // jsdom의 userAgent는 어떤 OS에서 돌리든 detectDesktopPlatform()이 "linux"로
  // 판정하므로, 이 환경에서 보이는 선택지는 auto|custom 두 가지다.
  it("터미널 섹션: 선택을 custom으로 바꾸면 커스텀 명령 입력이 나타나고 저장된다", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        terminal: { external: "auto", customCommand: "" },
      },
      loaded: true,
      showSettings: true,
    });
    render();

    const selects = Array.from(host.querySelectorAll("select"));
    const terminalSelect = selects.find((select) => select.value === "auto");
    expect(terminalSelect).toBeTruthy();
    expect(Array.from(terminalSelect!.options).map((o) => o.value)).toEqual([
      "auto",
      "custom",
    ]);

    // custom을 고르기 전에는 커스텀 명령 입력이 없다
    expect(host.querySelector('input[placeholder="alacritty --working-directory {{cwd}}"]')).toBeNull();

    await act(async () => {
      terminalSelect!.value = "custom";
      terminalSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useSettings.getState().settings.terminal.external).toBe("custom");
    const customInput = host.querySelector(
      'input[placeholder="alacritty --working-directory {{cwd}}"]',
    ) as HTMLInputElement;
    expect(customInput).toBeTruthy();

    // React 제어 input에 네이티브 setter로 값을 넣어야 change가 감지된다
    // (직접 대입은 React의 value 트래커를 건너뛴다).
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(customInput, "alacritty --working-directory {{cwd}}");
      customInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(useSettings.getState().settings.terminal.customCommand).toBe(
      "alacritty --working-directory {{cwd}}",
    );
  });
});
