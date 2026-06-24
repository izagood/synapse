import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./workspace";
import { ipc } from "../ipc/ipc";
import { mockSessionControl } from "../ipc/mock";
import type { FileNode } from "../ipc/types";

// node 환경에서는 ipc가 자동으로 mockIpc로 동작한다.
const MOCK_ROOT = "/mock/notes";

function findNode(name: string): FileNode {
  const walk = (nodes: Array<FileNode | null | undefined>): FileNode | null => {
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

describe("workspace → MCP 라이브 상태 브리지 push", () => {
  beforeEach(() => {
    mockSessionControl.states.clear();
    mockSessionControl.lastWorkspace = null;
    useWorkspace.getState().closeWorkspace();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("활성 노트·열린 탭·저장 전 라이브 버퍼를 디바운스로 올린다", async () => {
    const spy = vi.spyOn(ipc, "bridgePushState").mockResolvedValue(undefined);

    await useWorkspace.getState().openFolder(MOCK_ROOT);
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;

    // 저장하지 않은 편집 — 라이브 버퍼가 그대로 전달돼야 한다.
    useWorkspace.getState().updateContent(path, "# 라이브 편집 내용");

    // 디바운스(300ms) 발화를 기다린다.
    await new Promise((r) => setTimeout(r, 400));

    expect(spy).toHaveBeenCalled();
    const live = spy.mock.calls.at(-1)![0];
    expect(live.root).toBe(MOCK_ROOT);
    expect(live.activePath).toBe(path);
    expect(live.activeContent).toBe("# 라이브 편집 내용");
    expect(live.openTabs.some((t) => t.path === path)).toBe(true);
  });

  it("열린 노트가 없으면 activePath/activeContent는 null로 올린다", async () => {
    const spy = vi.spyOn(ipc, "bridgePushState").mockResolvedValue(undefined);

    await useWorkspace.getState().openFolder(MOCK_ROOT);
    await new Promise((r) => setTimeout(r, 400));

    expect(spy).toHaveBeenCalled();
    const live = spy.mock.calls.at(-1)![0];
    expect(live.root).toBe(MOCK_ROOT);
    expect(live.activePath).toBeNull();
    expect(live.activeContent).toBeNull();
  });
});
