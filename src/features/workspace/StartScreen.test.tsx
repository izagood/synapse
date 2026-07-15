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
    expect(host.textContent).toContain("시작하기");

    act(() => {
      useSettings.setState({
        settings: {
          ...useSettings.getState().settings,
          appearance: { theme: "system", language: "en", customColors: {}, canvasTheme: "light" },
        },
      });
    });

    expect(host.textContent).toContain("Open Folder");
    expect(host.textContent).toContain("Open by Path");
    expect(host.textContent).toContain("Recent Folders");
    expect(host.textContent).toContain("Getting Started");
  });

  it("shows the brand tagline in both languages", () => {
    render();
    expect(host.textContent).toContain("AI-native notes, plain Markdown");
  });

  it("marks remote recents with an SSH badge and scheme-less path", () => {
    act(() => {
      useWorkspace.setState({
        recent: ["/tmp/notes", "ssh://me@host/srv/plans"],
      });
    });
    render();

    expect(host.textContent).toContain("SSH");
    expect(host.textContent).toContain("me@host/srv/plans");
    // 로컬 항목은 배지 없이 경로 그대로
    expect(host.textContent).toContain("/tmp/notes");
    expect(host.querySelectorAll(".recent-badge")).toHaveLength(1);
  });

  it("clears the recent list via 모두 지우기", async () => {
    render();
    expect(host.textContent).toContain("/tmp/notes");

    const clear = host.querySelector<HTMLButtonElement>(".start-clear-recent");
    expect(clear).not.toBeNull();
    await act(async () => {
      clear!.click();
    });

    expect(useWorkspace.getState().recent).toEqual([]);
    expect(host.querySelector(".start-clear-recent")).toBeNull();
    expect(host.textContent).not.toContain("/tmp/notes");
  });
});
