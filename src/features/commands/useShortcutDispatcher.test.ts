import { describe, expect, it, vi } from "vitest";
import { dispatchShortcutEvent } from "./useShortcutDispatcher";
import { registerCommand } from "./registry";

function keyEvent(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...over,
  } as unknown as KeyboardEvent;
}

describe("shortcut dispatcher", () => {
  it("매칭된 단축키의 커맨드를 실행하고 preventDefault 한다", () => {
    const run = vi.fn();
    const off = registerCommand({
      id: "tab.closeOthers",
      titleKey: "tabs.closeOthers",
      category: "file",
      run,
    });
    const e = keyEvent({ key: "t", metaKey: true, altKey: true }); // ⌥⌘T
    dispatchShortcutEvent(e);
    expect(run).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
    off();
  });

  it("IME 조합 중(isComposing)에는 아무것도 하지 않는다", () => {
    const run = vi.fn();
    const off = registerCommand({
      id: "tab.closeOthers",
      titleKey: "tabs.closeOthers",
      category: "file",
      run,
    });
    dispatchShortcutEvent(
      keyEvent({ key: "t", metaKey: true, altKey: true, isComposing: true }),
    );
    expect(run).not.toHaveBeenCalled();
    off();
  });

  it("커맨드가 disabled면 preventDefault 하지 않는다 (OS 기본 동작 통과)", () => {
    const run = vi.fn();
    const off = registerCommand({
      id: "tab.close",
      titleKey: "tabs.close",
      category: "file",
      enabled: () => false,
      run,
    });
    const e = keyEvent({ key: "w", metaKey: true }); // ⌘W
    dispatchShortcutEvent(e);
    expect(run).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    off();
  });

  it("미등록 커맨드의 단축키는 조용히 통과한다", () => {
    const e = keyEvent({ key: "9", metaKey: true }); // tab.goTo9 — 미등록 상태
    expect(() => dispatchShortcutEvent(e)).not.toThrow();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("handledBy:editor 정의(⌘B 굵게 등)는 디스패치 대상이 아니다", () => {
    const run = vi.fn();
    // editor.bold 와 같은 키(⌘B)를 쓰는 app 정의는 view.toggleSidebar —
    // 그것만 등록돼 있으면 실행되고, editor 정의 때문에 중복 실행되지 않는다.
    const off = registerCommand({
      id: "view.toggleSidebar",
      titleKey: "shortcuts.desc.toggleSidebar",
      category: "view",
      run,
    });
    dispatchShortcutEvent(keyEvent({ key: "b", metaKey: true }));
    expect(run).toHaveBeenCalledOnce();
    off();
  });
});
