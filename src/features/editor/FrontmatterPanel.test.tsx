// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_SETTINGS } from "../../ipc/types";
import { useSettings } from "../../stores/settings";
import { FrontmatterPanel } from "./FrontmatterPanel";

let root: Root | null = null;
let host: HTMLDivElement;
let lastChange: string | null;

function render(frontmatter: string | null) {
  lastChange = null;
  root = createRoot(host);
  act(() => {
    root!.render(
      <FrontmatterPanel frontmatter={frontmatter} onChange={(next) => (lastChange = next)} />,
    );
  });
}

function expandPanel() {
  const toggle = host.querySelector(".frontmatter-panel-toggle") as HTMLButtonElement;
  act(() => toggle.click());
}

function setInputValue(el: HTMLInputElement, value: string) {
  // React가 추적하는 native value setter로 값을 넣고 input 이벤트 디스패치
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("FrontmatterPanel", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: true,
      showSettings: false,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it("renders nothing when there is no frontmatter", () => {
    render(null);
    expect(host.querySelector(".frontmatter-panel")).toBeNull();
  });

  it("shows the property count collapsed and rows when expanded", () => {
    render(["---", "title: 메모", "tags: [a, b]", "---"].join("\n"));
    expect(host.querySelector(".fm-count")?.textContent).toBe("2");
    expandPanel();
    expect(host.textContent).toContain("title");
    expect(host.textContent).toContain("a");
    expect(host.textContent).toContain("b");
  });

  it("edits a scalar value and preserves synapse_id verbatim", () => {
    render(["---", "synapse_id: 01HZX-CRDT", "title: 옛 제목", "---"].join("\n"));
    expandPanel();
    const titleInput = Array.from(host.querySelectorAll(".fm-row")).find((row) =>
      row.textContent?.includes("title"),
    )?.querySelector(".fm-scalar-input") as HTMLInputElement;
    setInputValue(titleInput, "새 제목");

    expect(lastChange).not.toBeNull();
    expect(lastChange).toContain("synapse_id: 01HZX-CRDT");
    expect(lastChange).toContain("title: 새 제목");
  });

  it("adds a tag via Enter", () => {
    render(["---", "tags: [a]", "---"].join("\n"));
    expandPanel();
    const tagInput = host.querySelector(".fm-tag-input") as HTMLInputElement;
    setInputValue(tagInput, "newtag");
    act(() => {
      tagInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(lastChange).toContain("tags: [a, newtag]");
  });

  it("disables editing of complex (non-modelable) properties", () => {
    render(["---", "title: ok", "meta:", "  nested: v", "---"].join("\n"));
    expandPanel();
    const metaRow = Array.from(host.querySelectorAll(".fm-row")).find((row) =>
      row.textContent?.includes("meta"),
    ) as HTMLElement;
    expect(metaRow.className).toContain("fm-row-readonly");
    const input = metaRow.querySelector(".fm-scalar-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("removes a property", () => {
    render(["---", "a: 1", "b: 2", "---"].join("\n"));
    expandPanel();
    const rowA = Array.from(host.querySelectorAll(".fm-row")).find((row) =>
      row.querySelector(".fm-key")?.textContent === "a",
    ) as HTMLElement;
    const removeBtn = rowA.querySelector(".fm-remove") as HTMLButtonElement;
    act(() => removeBtn.click());
    expect(lastChange).toBe(["---", "b: 2", "---"].join("\n"));
  });
});
