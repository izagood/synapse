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
});
