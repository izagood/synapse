import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDirty, useWorkspace } from "./workspace";
import { ipc } from "../ipc/ipc";
import { mockSessionControl } from "../ipc/mock";
import type { FileNode } from "../ipc/types";

// node 환경에서는 ipc가 자동으로 mockIpc로 동작한다 (src/ipc/ipc.ts의 isTauri 분기)
const MOCK_ROOT = "/mock/notes";

function findMaybeNode(name: string): FileNode | null {
  const walk = (nodes: Array<FileNode | null>): FileNode | null => {
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

function findNode(name: string): FileNode {
  const node = findMaybeNode(name);
  if (!node) {
    throw new Error(`missing test node: ${name}`);
  }
  return node;
}

describe("workspace store (mock ipc)", () => {
  beforeEach(async () => {
    mockSessionControl.states.clear();
    mockSessionControl.lastWorkspace = null;
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

  it("openFileAt opens a file in the tree by absolute path (internal link)", async () => {
    const opened = await useWorkspace.getState().openFileAt(`${MOCK_ROOT}/daily/2026-06-10.md`);
    expect(opened).toBe(true);
    const s = useWorkspace.getState();
    expect(s.activePath).toBe(`${MOCK_ROOT}/daily/2026-06-10.md`);
    expect(s.tabs.map((t) => t.name)).toEqual(["2026-06-10.md"]);
    expect(s.tabs[0].fileType).toBe("markdown");
  });

  it("openFileAt falls back to the .md extension for extension-less links", async () => {
    const opened = await useWorkspace.getState().openFileAt(`${MOCK_ROOT}/README`);
    expect(opened).toBe(true);
    expect(useWorkspace.getState().activePath).toBe(`${MOCK_ROOT}/README.md`);
  });

  it("openFileAt returns false for paths missing from the tree", async () => {
    const opened = await useWorkspace.getState().openFileAt(`${MOCK_ROOT}/없는 파일.md`);
    expect(opened).toBe(false);
    expect(useWorkspace.getState().tabs).toEqual([]);
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
      // 마크다운 저장은 CRDT 경로 — synapse_id가 주입된 채로 저장된다
      expect(await ipc.readFile(MOCK_ROOT, path)).toContain("# 수정됨");
      expect(await ipc.readFile(MOCK_ROOT, path)).toContain("synapse_id:");
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
    expect(await ipc.readFile(MOCK_ROOT, closing)).toContain("닫기 전 수정");
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
    expect(await ipc.readFile(MOCK_ROOT, other)).toContain("닫히기 전 저장될 내용");
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

  it("restores saved session tabs on reopen, skipping deleted files", async () => {
    const readme = findNode("README.md");
    const daily = findNode("2026-06-10.md");
    mockSessionControl.states.set(MOCK_ROOT, {
      openTabs: [
        { path: readme.path, name: readme.name, fileType: "markdown" },
        { path: `${MOCK_ROOT}/없어진 파일.md`, name: "없어진 파일.md", fileType: "markdown" },
        { path: daily.path, name: daily.name, fileType: "markdown" },
      ],
      activePath: readme.path,
    });

    await useWorkspace.getState().openFolder(MOCK_ROOT);
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.name)).toEqual(["README.md", "2026-06-10.md"]);
    expect(s.activePath).toBe(readme.path);
    // 복원된 탭의 문서가 디스크 내용으로 로드되어 있어야 한다
    const doc = s.docs[readme.path];
    expect(doc.loading).toBe(false);
    expect(doc.content).toBe(await ipc.readFile(MOCK_ROOT, readme.path));
  });

  it("init reopens the last workspace unless explicitly closed", async () => {
    useWorkspace.getState().closeWorkspace(); // 명시적 닫기 → lastWorkspace 해제
    expect(mockSessionControl.lastWorkspace).toBeNull();

    mockSessionControl.lastWorkspace = MOCK_ROOT;
    await useWorkspace.getState().init();
    expect(useWorkspace.getState().root).toBe(MOCK_ROOT);
  });

  it("persists tabs and active path after the debounce delay", async () => {
    vi.useFakeTimers();
    try {
      await useWorkspace.getState().openFile(findNode("README.md"));
      await vi.advanceTimersByTimeAsync(600);
      const saved = mockSessionControl.states.get(MOCK_ROOT);
      expect(saved?.openTabs.map((t) => t.name)).toEqual(["README.md"]);
      expect(saved?.activePath).toContain("README.md");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renameEntry saves, renames, and reopens the tab at the new path", async () => {
    const readme = findNode("README.md");
    await useWorkspace.getState().openFile(readme);
    useWorkspace.getState().updateContent(readme.path, "이름 바꾸기 전 내용");

    await useWorkspace.getState().renameEntry(readme, "소개.md");
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.name)).toEqual(["소개.md"]);
    expect(s.activePath).toContain("소개.md");
    expect(await ipc.readFile(MOCK_ROOT, s.activePath!)).toContain("이름 바꾸기 전 내용");
    expect(findMaybeNode("README.md")).toBeNull();
    // 정리: 다음 테스트를 위해 되돌린다
    await useWorkspace.getState().renameEntry(findNode("소개.md"), "README.md");
  });

  it("deleteEntry closes the tab without saving and removes the file", async () => {
    await useWorkspace.getState().createNote();
    const note = useWorkspace.getState().tabs.at(-1)!;
    useWorkspace.getState().updateContent(note.path, "저장되면 안 되는 내용");

    await useWorkspace.getState().deleteEntry({ path: note.path, kind: "file" });
    const s = useWorkspace.getState();
    expect(s.tabs.find((t) => t.path === note.path)).toBeUndefined();
    expect(findMaybeNode(note.name)).toBeNull();
    await expect(ipc.readFile(MOCK_ROOT, note.path)).rejects.toThrow();
  });

  it("duplicateEntry creates a suffixed copy and opens it", async () => {
    const readme = findNode("README.md");
    await useWorkspace.getState().duplicateEntry(readme);
    const s = useWorkspace.getState();
    expect(s.activePath).toContain("README 2.md");
    expect(await ipc.readFile(MOCK_ROOT, s.activePath!)).toBe(
      await ipc.readFile(MOCK_ROOT, readme.path),
    );
    await useWorkspace.getState().deleteEntry({ path: s.activePath!, kind: "file" });
  });

  it("markdown saveDoc injects synapse_id and bumps externalRev", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(path, "# 협업 문서");

    await useWorkspace.getState().saveDoc(path);
    const doc = useWorkspace.getState().docs[path];
    // 저장 결과(id 주입)가 에디터 content에 반영되고 rev가 올라 에디터가 다시 그린다
    expect(doc.content).toContain("synapse_id:");
    expect(doc.content).toContain("# 협업 문서");
    expect(doc.externalRev).toBe(1);
    expect(isDirty(doc)).toBe(false);
  });

  it("flushDirty saves every dirty doc before sync", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
    const [a, b] = useWorkspace.getState().tabs.map((t) => t.path);
    useWorkspace.getState().updateContent(a, "A 수정");
    useWorkspace.getState().updateContent(b, "B 수정");

    await useWorkspace.getState().flushDirty();
    expect(isDirty(useWorkspace.getState().docs[a])).toBe(false);
    expect(isDirty(useWorkspace.getState().docs[b])).toBe(false);
    expect(await ipc.readFile(MOCK_ROOT, a)).toContain("A 수정");
    expect(await ipc.readFile(MOCK_ROOT, b)).toContain("B 수정");
  });

  it("reloadAfterSync applies remote changes to clean open docs", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    // 원격 pull로 디스크가 바뀐 상황을 모사
    await ipc.writeFile(MOCK_ROOT, path, "# 원격에서 합쳐진 내용");

    await useWorkspace.getState().reloadAfterSync();
    const doc = useWorkspace.getState().docs[path];
    expect(doc.content).toBe("# 원격에서 합쳐진 내용");
    expect(doc.savedContent).toBe("# 원격에서 합쳐진 내용");
    expect(doc.externalRev).toBe(1);
  });

  it("surfaces errors for an invalid folder", async () => {
    await useWorkspace.getState().openFolder("/does/not/exist");
    const s = useWorkspace.getState();
    expect(s.error).toContain("not a directory");
  });

  it("openRemote forwards the SSH key path to connectRemote", async () => {
    const spy = vi
      .spyOn(ipc, "connectRemote")
      .mockResolvedValue({ root: MOCK_ROOT });
    try {
      const err = await useWorkspace.getState().openRemote("ssh://me@host", {
        keyPath: "/home/me/.ssh/work_key",
        acceptNewHostKey: false,
      });
      expect(err).toBeNull();
      // 인자 순서: uri, keyPath, password, passphrase, acceptNewHostKey
      expect(spy).toHaveBeenCalledWith(
        "ssh://me@host",
        "/home/me/.ssh/work_key",
        null,
        null,
        false,
      );
    } finally {
      spy.mockRestore();
    }
  });

  describe("파일 트리 자동 reveal", () => {
    it("toggleDir로 폴더를 펼치고 접는다", () => {
      const dir = `${MOCK_ROOT}/daily`;
      useWorkspace.getState().toggleDir(dir);
      expect(useWorkspace.getState().expandedDirs[dir]).toBe(true);
      useWorkspace.getState().toggleDir(dir);
      expect(useWorkspace.getState().expandedDirs[dir]).toBeUndefined();
    });

    it("openFile로 중첩 파일을 열면 조상 폴더가 펼쳐진다", async () => {
      await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
      expect(useWorkspace.getState().expandedDirs[`${MOCK_ROOT}/daily`]).toBe(true);
    });

    it("사용자가 접은 조상 폴더도 탭을 다시 전환하면 펼쳐진다", async () => {
      await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
      await useWorkspace.getState().openFile(findNode("README.md"));
      useWorkspace.getState().toggleDir(`${MOCK_ROOT}/daily`); // 펼쳐진 것을 접음
      expect(useWorkspace.getState().expandedDirs[`${MOCK_ROOT}/daily`]).toBeUndefined();

      useWorkspace.getState().setActiveTab(findNode("2026-06-10.md").path);
      expect(useWorkspace.getState().expandedDirs[`${MOCK_ROOT}/daily`]).toBe(true);
    });

    it("활성 탭을 닫아 이웃 탭이 활성화될 때도 reveal된다", async () => {
      await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
      await useWorkspace.getState().openFile(findNode("summary.html"));
      // daily를 접은 상태에서 summary 탭을 닫으면 daily 파일이 활성화되며 펼쳐져야 한다
      useWorkspace.getState().toggleDir(`${MOCK_ROOT}/daily`);
      await useWorkspace.getState().closeTab(`${MOCK_ROOT}/ai/summary.html`);

      expect(useWorkspace.getState().activePath).toBe(`${MOCK_ROOT}/daily/2026-06-10.md`);
      expect(useWorkspace.getState().expandedDirs[`${MOCK_ROOT}/daily`]).toBe(true);
    });

    it("reveal은 펼치기만 하고 무관한 폴더를 접지 않는다", async () => {
      const other = `${MOCK_ROOT}/ai`;
      useWorkspace.getState().toggleDir(other); // 사용자가 펼쳐 둠
      await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
      expect(useWorkspace.getState().expandedDirs[other]).toBe(true);
    });

    it("워크스페이스를 다시 열면 expandedDirs가 초기화된다", async () => {
      useWorkspace.getState().toggleDir(`${MOCK_ROOT}/daily`);
      await useWorkspace.getState().openFolder(MOCK_ROOT);
      expect(useWorkspace.getState().expandedDirs).toEqual({});
    });
  });
});
