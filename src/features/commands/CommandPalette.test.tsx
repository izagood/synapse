// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { CommandPalette, visiblePaletteCommands } from "./CommandPalette";
import { registerCommand, type CommandDef } from "./registry";

let root: Root | null = null;
let host: HTMLDivElement;
let offs: Array<() => void> = [];

function render(onClose: () => void = () => {}) {
  root = createRoot(host);
  act(() => {
    root!.render(<CommandPalette onClose={onClose} />);
  });
}

function reg(def: CommandDef) {
  offs.push(registerCommand(def));
}

describe("CommandPalette", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    reg({ id: "tab.closeOthers", titleKey: "tabs.closeOthers", category: "file", run: vi.fn() });
    reg({
      id: "t.hidden",
      titleKey: "tabs.close",
      category: "file",
      hideFromPalette: true,
      run: vi.fn(),
    });
    reg({
      id: "t.disabled",
      titleKey: "tabs.closeAll",
      category: "file",
      enabled: () => false,
      run: vi.fn(),
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
    offs.forEach((off) => off());
    offs = [];
  });

  it("hideFromPalette·disabled 커맨드는 목록에 없다", () => {
    render();
    expect(host.textContent).toContain("다른 탭 모두 닫기");
    expect(host.textContent).not.toContain("모든 탭 닫기");
  });

  it("검색으로 거르고 Enter로 실행 후 닫힌다", () => {
    const onClose = vi.fn();
    const run = vi.fn();
    reg({ id: "t.run", titleKey: "shortcuts.desc.save", category: "file", run });
    render(onClose);
    const input = host.querySelector("input")!;
    act(() => {
      // React controlled input — 네이티브 setter로 값을 넣어야 onChange가 발화한다
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(input, "저장");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll("li button")).toHaveLength(1);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("바인딩이 있는 커맨드는 키 라벨을 표시한다 (없으면 라벨 없음)", () => {
    reg({ id: "t.nokey", titleKey: "tabs.closeRight", category: "file", run: vi.fn() });
    render();
    const labels = [...host.querySelectorAll(".palette-key")].map((el) => el.textContent);
    expect(labels.length).toBeGreaterThan(0); // tab.closeOthers → ⌥⌘T 계열
    const rightRow = [...host.querySelectorAll("li button")].find((b) =>
      b.textContent?.includes("오른쪽 탭 닫기"),
    )!;
    expect(rightRow.querySelector(".palette-key")).toBeNull();
  });

  it("Escape로 닫힌다", () => {
    const onClose = vi.fn();
    render(onClose);
    act(() => {
      host
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("visiblePaletteCommands", () => {
  const t = (k: string) => `[${k}]`;

  it("제목순 정렬·쿼리 필터·숨김 규칙", () => {
    const cmds: Record<string, CommandDef> = {
      b: { id: "b", titleKey: "tabs.close", category: "file", run: () => {} },
      a: { id: "a", titleKey: "tabs.closeAll", category: "file", run: () => {} },
      h: {
        id: "h",
        titleKey: "tabs.closeOthers",
        category: "file",
        hideFromPalette: true,
        run: () => {},
      },
    };
    const all = visiblePaletteCommands(cmds, "", t as never);
    expect(all.map((i) => i.cmd.id)).toEqual(["b", "a"]); // [tabs.close] < [tabs.closeAll]
    const filtered = visiblePaletteCommands(cmds, "closeall", t as never);
    expect(filtered.map((i) => i.cmd.id)).toEqual(["a"]);
  });
});
