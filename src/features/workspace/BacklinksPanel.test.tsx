// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_SETTINGS } from "../../ipc/types";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { BacklinksPanel } from "./BacklinksPanel";

const PATH = "/mock/notes/README.md";

let root: Root | null = null;
let host: HTMLDivElement;

function render() {
  root = createRoot(host);
  act(() => {
    root!.render(<BacklinksPanel />);
  });
}

function setShowBacklinks(showBacklinks: boolean) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.editor.showBacklinks = showBacklinks;
  useSettings.setState({ settings, loaded: true, showSettings: false });
}

describe("BacklinksPanel 표시 설정", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    useWorkspace.setState({
      root: "/mock/notes",
      activePath: PATH,
      docs: {
        [PATH]: {
          content: "hello",
          savedContent: "hello",
          externalRev: 0,
          externalStale: false,
          loading: false,
          error: null,
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it("기본값(showBacklinks=false)에서는 패널이 렌더되지 않는다", () => {
    setShowBacklinks(false);
    render();
    expect(host.querySelector(".backlinks-panel")).toBeNull();
  });

  it("showBacklinks=true 면 패널이 렌더된다", () => {
    setShowBacklinks(true);
    render();
    expect(host.querySelector(".backlinks-panel")).not.toBeNull();
  });

  it("설정이 켜졌다 꺼지면 패널이 사라진다", () => {
    setShowBacklinks(true);
    render();
    expect(host.querySelector(".backlinks-panel")).not.toBeNull();
    act(() => {
      setShowBacklinks(false);
    });
    expect(host.querySelector(".backlinks-panel")).toBeNull();
  });
});
