// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { CreateMenu } from "./CreateMenu";

let root: Root | null = null;
let host: HTMLDivElement;

const noop = () => {};

function renderMenu(
  props: Partial<Parameters<typeof CreateMenu>[0]> = {},
) {
  const full = {
    anchor: { x: 10, y: 10 },
    onNote: noop,
    onFolder: noop,
    onDrawing: noop,
    onDiagram: noop,
    onClose: noop,
    ...props,
  };
  root = createRoot(host);
  act(() => {
    root!.render(<CreateMenu {...full} />);
  });
}

function menuLabels(): string[] {
  return [...host.querySelectorAll(".context-menu button")].map(
    (b) => b.textContent ?? "",
  );
}

function clickLabel(label: string) {
  const btn = [...host.querySelectorAll(".context-menu button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
  act(() => {
    btn.click();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe("CreateMenu", () => {
  it("새 노트·새 폴더·새 드로잉·새 다이어그램 4개 항목을 표시한다", () => {
    renderMenu();
    expect(menuLabels()).toEqual(["새 노트", "새 폴더", "새 드로잉", "새 다이어그램"]);
  });

  it("'새 노트'를 누르면 onNote와 onClose가 호출된다", () => {
    const onNote = vi.fn();
    const onClose = vi.fn();
    renderMenu({ onNote, onClose });
    clickLabel("새 노트");
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("'새 폴더'를 누르면 onFolder가 호출된다", () => {
    const onFolder = vi.fn();
    renderMenu({ onFolder });
    clickLabel("새 폴더");
    expect(onFolder).toHaveBeenCalledTimes(1);
  });

  it("Escape를 누르면 onClose가 호출된다", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
