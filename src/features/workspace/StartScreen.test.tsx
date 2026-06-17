// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_SETTINGS } from "../../ipc/types";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { StartScreen } from "./StartScreen";

let root: Root | null = null;
let host: HTMLDivElement;

function render() {
  root = createRoot(host);
  act(() => {
    root!.render(<StartScreen />);
  });
}

describe("StartScreen i18n", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: true,
      showSettings: false,
    });
    useWorkspace.setState({
      recent: ["/tmp/notes"],
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it("renders Korean and English shell copy", () => {
    render();
    expect(host.textContent).toContain("폴더 열기");
    expect(host.textContent).toContain("경로로 열기");
    expect(host.textContent).toContain("최근 폴더");

    act(() => {
      useSettings.setState({
        settings: {
          ...useSettings.getState().settings,
          appearance: { theme: "system", language: "en", customColors: {} },
        },
      });
    });

    expect(host.textContent).toContain("Open Folder");
    expect(host.textContent).toContain("Open by Path");
    expect(host.textContent).toContain("Recent Folders");
  });
});
