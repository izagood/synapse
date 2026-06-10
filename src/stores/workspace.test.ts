import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDirty, useWorkspace } from "./workspace";
import { ipc } from "../ipc/ipc";

// node 환경에서는 ipc가 자동으로 mockIpc로 동작한다 (src/ipc/ipc.ts의 isTauri 분기)
const MOCK_ROOT = "/mock/notes";

function findNode(name: string) {
  const walk = (nodes: ReturnType<typeof useWorkspace.getState>["tree"][]): any => {
    for (const n of nodes) {
      if (!n) continue;
      if (n.name === name) return n;
      const found = n.children ? walk(n.children) : null;
      if (found) return found;
    }
    return null;
  };
  return walk([useWorkspace.getState().tree]);
}

describe("workspace store (mock ipc)", () => {
  beforeEach(async () => {
    useWorkspace.getState().closeWorkspace();
    await useWorkspace.getState().openFolder(MOCK_ROOT);
  });

  it("opens a folder: tree loaded and recorded in recent", () => {
    const s = useWorkspace.getState();
    expect(s.root).toBe(MOCK_ROOT);
    expect(s.tree?.kind).toBe("dir");
    expect(s.tree?.children?.length).toBeGreaterThan(0);
    expect(s.recent[0]).toBe(MOCK_ROOT);
    expect(s.error).toBeNull();
  });

  it("opens a file in a tab and loads content", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.name)).toEqual(["README.md"]);
    expect(s.activePath).toContain("README.md");
    expect(s.docs[s.activePath!].content).toContain("Mock 워크스페이스");
    expect(isDirty(s.docs[s.activePath!])).toBe(false);
  });

  it("keeps multiple tabs and switches active", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    let s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activePath).toContain("2026-06-10.md");

    s.setActiveTab(s.tabs[0].path);
    s = useWorkspace.getState();
    expect(s.activePath).toContain("README.md");
  });

  it("updateContent marks dirty, autosave persists after delay", async () => {
    vi.useFakeTimers();
    try {
      await useWorkspace.getState().openFile(findNode("README.md"));
      const path = useWorkspace.getState().activePath!;
      useWorkspace.getState().updateContent(path, "# 수정됨");
      expect(isDirty(useWorkspace.getState().docs[path])).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);
      expect(isDirty(useWorkspace.getState().docs[path])).toBe(false);
      expect(await ipc.readFile(MOCK_ROOT, path)).toBe("# 수정됨");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeTab saves pending changes and activates a neighbor", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    const closing = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(closing, "닫기 전 수정");

    await useWorkspace.getState().closeTab(closing);
    const s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activePath).toContain("README.md");
    expect(await ipc.readFile(MOCK_ROOT, closing)).toBe("닫기 전 수정");
  });

  it("createNote creates, refreshes the tree, and opens a markdown tab", async () => {
    await useWorkspace.getState().createNote();
    const s = useWorkspace.getState();
    expect(s.activePath).toMatch(/새 노트.*\.md$/);
    expect(s.tabs.at(-1)?.fileType).toBe("markdown");
    expect(findNode(s.tabs.at(-1)!.name)).toBeTruthy();
  });

  it("closeOtherTabs keeps only the given tab, saving dirty ones", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    await useWorkspace.getState().openFile(findNode("summary.html"));
    const keep = useWorkspace.getState().tabs[1].path;
    const other = useWorkspace.getState().tabs[0].path;
    useWorkspace.getState().updateContent(other, "닫히기 전 저장될 내용");

    await useWorkspace.getState().closeOtherTabs(keep);
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.path)).toEqual([keep]);
    expect(s.activePath).toBe(keep);
    expect(await ipc.readFile(MOCK_ROOT, other)).toBe("닫히기 전 저장될 내용");
  });

  it("closeTabsToRight closes only tabs after the given one", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    await useWorkspace.getState().openFile(findNode("summary.html"));
    const first = useWorkspace.getState().tabs[0].path;

    await useWorkspace.getState().closeTabsToRight(first);
    expect(useWorkspace.getState().tabs.map((t) => t.path)).toEqual([first]);
  });

  it("closeAllTabs empties the tab bar", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    await useWorkspace.getState().closeAllTabs();
    const s = useWorkspace.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activePath).toBeNull();
  });

  it("surfaces errors for an invalid folder", async () => {
    await useWorkspace.getState().openFolder("/does/not/exist");
    const s = useWorkspace.getState();
    expect(s.error).toContain("not a directory");
  });
});
