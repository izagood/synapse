// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { TitleBar } from "./TitleBar";

let root: Root | null = null;
let host: HTMLDivElement;

function render(ui: React.ReactElement) {
  root = createRoot(host);
  act(() => {
    root!.render(ui);
  });
}

describe("TitleBar", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it("macOS에서 폴더명을 command center 버튼으로 그리고 클릭 시 팔레트를 연다", () => {
    const onOpen = vi.fn();
    render(<TitleBar title="my-notes" onOpenPalette={onOpen} platform="macos" />);
    const btn = host.querySelector<HTMLButtonElement>(".titlebar-command-center");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("my-notes");
    act(() => {
      btn!.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("스트립에 창 드래그 속성(data-tauri-drag-region)이 달려 있다", () => {
    render(<TitleBar title="t" onOpenPalette={() => {}} platform="macos" />);
    expect(
      host.querySelector(".titlebar")?.hasAttribute("data-tauri-drag-region"),
    ).toBe(true);
  });

  it("onOpenPalette가 없으면 버튼 대신 정적 라벨만 그린다 (시작 화면)", () => {
    render(<TitleBar title="Synapse" platform="macos" />);
    expect(host.querySelector(".titlebar-command-center")).toBeNull();
    expect(host.textContent).toContain("Synapse");
  });

  it("macOS가 아니면 네이티브 타이틀바가 있으므로 아무것도 그리지 않는다", () => {
    render(<TitleBar title="x" onOpenPalette={() => {}} platform="windows" />);
    expect(host.querySelector(".titlebar")).toBeNull();
  });
});
