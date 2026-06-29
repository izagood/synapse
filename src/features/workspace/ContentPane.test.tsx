// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_SETTINGS } from "../../ipc/types";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { SAMPLE_DRAWIO_XML } from "../drawio/fixtures";
import { ContentPane } from "./ContentPane";

const PATH = "/w/diagrams/flow.drawio";

let root: Root | null = null;
let host: HTMLDivElement;

function render() {
  root = createRoot(host);
  act(() => {
    root!.render(<ContentPane />);
  });
}

describe("ContentPane drawio routing", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: true,
      showSettings: false,
    });
    useWorkspace.setState({
      tabs: [{ path: PATH, name: "flow.drawio", fileType: "drawio" }],
      activePath: PATH,
      docs: {
        [PATH]: {
          content: SAMPLE_DRAWIO_XML,
          savedContent: SAMPLE_DRAWIO_XML,
          externalRev: 0,
          loading: false,
          error: null,
        },
      },
      sourceMode: false,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it("renders the drawio editor directly with no viewer mode toggle", () => {
    render();
    expect(host.querySelector("iframe.drawio-editor")).not.toBeNull();
    expect(host.querySelector(".drawio-mode-toggle")).toBeNull();
  });
});
