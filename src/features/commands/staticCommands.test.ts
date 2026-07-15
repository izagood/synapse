import { beforeEach, describe, expect, it } from "vitest";
import { registerStaticCommands } from "./staticCommands";
import { getCommand } from "./registry";
import { useWorkspace } from "../../stores/workspace";
import { mockSessionControl } from "../../ipc/mock";
import type { FileNode } from "../../ipc/types";

const MOCK_ROOT = "/mock/notes";

function findNode(name: string): FileNode {
  const walk = (nodes: Array<FileNode | null>): FileNode | null => {
    for (const n of nodes) {
      if (!n) continue;
      if (n.name === name) return n;
      const found = n.children ? walk(n.children) : null;
      if (found) return found;
    }
    return null;
  };
  const node = walk([useWorkspace.getState().tree]);
  if (!node) throw new Error(`missing test node: ${name}`);
  return node;
}

describe("정적 커맨드", () => {
  beforeEach(async () => {
    registerStaticCommands();
    registerStaticCommands(); // 멱등 — 중복 호출해도 최신 def 1개
    mockSessionControl.states.clear();
    mockSessionControl.lastWorkspace = null;
    useWorkspace.getState().closeWorkspace();
    await useWorkspace.getState().openFolder(MOCK_ROOT);
  });

  it("탭·파일·터미널·창·설정 커맨드가 모두 등록되어 있다", () => {
    for (const id of [
      "tab.close",
      "tab.closeOthers",
      "tab.closeRight",
      "tab.closeAll",
      "tab.next",
      "tab.prev",
      "tab.reopen",
      "file.save",
      "file.newNote",
      "file.newDrawing",
      "file.newDiagram",
      "view.toggleTerminal",
      "window.new",
      "settings.toggle",
      "help.cheatsheet",
    ]) {
      expect(getCommand(id), id).toBeDefined();
    }
    for (let n = 1; n <= 9; n++) {
      const cmd = getCommand(`tab.goTo${n}`);
      expect(cmd, `tab.goTo${n}`).toBeDefined();
      expect(cmd?.hideFromPalette).toBe(true);
    }
  });

  it("tab.closeOthers는 활성 탭 외 전부 닫는다 (탭 1개면 disabled)", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    expect(getCommand("tab.closeOthers")!.enabled!()).toBe(false);
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    expect(getCommand("tab.closeOthers")!.enabled!()).toBe(true);
    await getCommand("tab.closeOthers")!.run();
    const s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].name).toBe("2026-06-10.md");
  });

  it("tab.closeRight는 활성 탭이 마지막이면 disabled", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    expect(getCommand("tab.closeRight")!.enabled!()).toBe(false); // 활성=마지막
    useWorkspace.getState().setActiveTab(findNode("README.md").path);
    expect(getCommand("tab.closeRight")!.enabled!()).toBe(true);
    await getCommand("tab.closeRight")!.run();
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });

  it("탭이 없으면 tab.close는 disabled (OS 창 닫기에 맡김)", async () => {
    await useWorkspace.getState().closeAllTabs();
    expect(getCommand("tab.close")!.enabled!()).toBe(false);
  });

  it("tab.reopen은 닫은 탭이 없으면 disabled, 있으면 복원한다", async () => {
    expect(getCommand("tab.reopen")!.enabled!()).toBe(false);
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    await useWorkspace.getState().closeTab(path);
    expect(getCommand("tab.reopen")!.enabled!()).toBe(true);
    await getCommand("tab.reopen")!.run();
    expect(useWorkspace.getState().tabs.some((t) => t.path === path)).toBe(true);
  });
});
