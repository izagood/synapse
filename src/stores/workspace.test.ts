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

  it("워크스페이스를 연 뒤 레거시 `.synapse/` 정리를 fire-and-forget으로 부른다", async () => {
    const spy = vi.spyOn(ipc, "migrateWorkspace");
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    expect(spy).toHaveBeenCalledWith(MOCK_ROOT);
  });

  it("migrateWorkspace가 실패해도 워크스페이스 열기 자체는 성공한다", async () => {
    vi.spyOn(ipc, "migrateWorkspace").mockRejectedValueOnce(new Error("boom"));
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    const s = useWorkspace.getState();
    expect(s.root).toBe(MOCK_ROOT);
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

  it("사이드바 선택 열기(focusEditor:false)는 에디터 자동 포커스를 끄고, 기본 열기·탭 전환은 켠다", async () => {
    const ws = useWorkspace.getState();
    const readme = findNode("README.md");

    // 사이드바에서 "선택"으로 열면 포커스를 트리 행에 두기 위해 자동 포커스 꺼짐
    await ws.openFile(readme, { focusEditor: false });
    expect(useWorkspace.getState().autoFocusEditor).toBe(false);

    // 기본(opts 없음) 열기 — 퀵오픈·내부 링크 등 — 은 다시 켜짐
    await ws.openFile(readme);
    expect(useWorkspace.getState().autoFocusEditor).toBe(true);

    // 다시 끈 뒤 탭 전환(setActiveTab)도 "이 문서를 편집" 의도라 켜짐
    await ws.openFile(readme, { focusEditor: false });
    expect(useWorkspace.getState().autoFocusEditor).toBe(false);
    useWorkspace.getState().setActiveTab(useWorkspace.getState().activePath!);
    expect(useWorkspace.getState().autoFocusEditor).toBe(true);
  });

  it("PDF는 텍스트로 읽지 않고 곧장 준비 완료 상태가 된다", async () => {
    // 바이너리라 read_to_string이 UTF-8 디코드에서 실패하므로 readFile을 건너뛴다.
    const spy = vi.spyOn(ipc, "readFile");
    await useWorkspace.getState().openFile({
      path: `${MOCK_ROOT}/report.pdf`,
      name: "report.pdf",
      kind: "file",
      fileType: "pdf",
    });
    const s = useWorkspace.getState();
    expect(s.activePath).toBe(`${MOCK_ROOT}/report.pdf`);
    expect(s.tabs[0].fileType).toBe("pdf");
    const doc = s.docs[s.activePath!];
    expect(doc.loading).toBe(false);
    expect(doc.error).toBeNull();
    expect(doc.content).toBe("");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("opens an image without reading it as text (binary safe)", async () => {
    const readSpy = vi.spyOn(ipc, "readFile");
    const image = findNode("diagram.png");
    expect(image.fileType).toBe("image");
    await useWorkspace.getState().openFile(image);
    const s = useWorkspace.getState();
    expect(s.activePath).toContain("diagram.png");
    const doc = s.docs[s.activePath!];
    expect(doc.loading).toBe(false);
    expect(doc.error).toBeNull();
    expect(doc.content).toBe("");
    // 바이너리이므로 readFile을 호출하면 안 된다 (invalid utf-8 방지)
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("stale fileType('other')로 들어온 PDF/이미지 탭을 파일명으로 재분류한다", async () => {
    // 구버전(PDF/이미지 분류 이전)에서 저장된 세션은 .pdf/.png 탭을 fileType:"other"로
    // 굳혀 둔다. 그 값을 그대로 믿으면 바이너리 분기를 못 타고 readFile→UTF-8 디코드
    // 에러("invalid utf-8 sequence")가 난다. openFile은 파일명으로 재계산해 교정한다.
    const spy = vi.spyOn(ipc, "readFile");
    await useWorkspace.getState().openFile({
      path: `${MOCK_ROOT}/report.pdf`,
      name: "report.pdf",
      kind: "file",
      fileType: "other", // ← 구버전이 저장한 stale 값
    });
    let s = useWorkspace.getState();
    expect(s.tabs.find((t) => t.name === "report.pdf")?.fileType).toBe("pdf");
    expect(s.docs[`${MOCK_ROOT}/report.pdf`].error).toBeNull();

    const image = findNode("diagram.png");
    await useWorkspace.getState().openFile({ ...image, fileType: "other" });
    s = useWorkspace.getState();
    expect(s.tabs.find((t) => t.name === "diagram.png")?.fileType).toBe("image");
    expect(s.docs[image.path].error).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // 바이너리는 끝까지 readFile 금지
    spy.mockRestore();
  });

  it("세션 복원 시 stale fileType('other')인 바이너리 탭도 텍스트로 읽지 않는다", async () => {
    // 사용자 버그 재현: 구버전에서 .png 탭을 연 채 종료 → 세션에 fileType:"other"로
    // 저장 → 신버전에서 복원하면 readFile→UTF-8 에러. 복원 경로도 교정되어야 한다.
    const image = findNode("diagram.png");
    mockSessionControl.states.set(MOCK_ROOT, {
      openTabs: [{ path: image.path, name: image.name, fileType: "other" }],
      activePath: image.path,
    });
    const spy = vi.spyOn(ipc, "readFile");
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    const s = useWorkspace.getState();
    expect(s.tabs.find((t) => t.name === "diagram.png")?.fileType).toBe("image");
    expect(s.docs[image.path].error).toBeNull();
    expect(s.docs[image.path].loading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
      // 저장 = 그냥 원자적 쓰기 (라이브 머지·synapse_id 주입 없음)
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
    expect(await ipc.readFile(MOCK_ROOT, closing)).toContain("닫기 전 수정");
  });

  it("closeTab on the last open tab empties the workspace (⌘W then closes the window)", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const only = useWorkspace.getState().activePath!;

    await useWorkspace.getState().closeTab(only);
    const s = useWorkspace.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activePath).toBeNull();
  });

  it("createNote creates, refreshes the tree, and opens a markdown tab", async () => {
    await useWorkspace.getState().createNote();
    const s = useWorkspace.getState();
    expect(s.activePath).toMatch(/새 노트.*\.md$/);
    expect(s.tabs.at(-1)?.fileType).toBe("markdown");
    expect(findNode(s.tabs.at(-1)!.name)).toBeTruthy();
  });

  it("createFolder creates a folder, refreshes the tree, and returns its path", async () => {
    const path = await useWorkspace.getState().createFolder();
    expect(path).toMatch(/\/새 폴더$/);
    const node = findNode("새 폴더");
    expect(node.kind).toBe("dir");
    // 노트와 달리 에디터로 열지 않는다 (탭/activePath 변화 없음)
    expect(useWorkspace.getState().tabs.some((t) => t.name === "새 폴더")).toBe(false);
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

  it("markdown saveDoc is a plain write when there is no legacy synapse_id", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(path, "# 협업 문서");

    await useWorkspace.getState().saveDoc(path);
    const doc = useWorkspace.getState().docs[path];
    // 저장 = 그냥 원자적 쓰기 — 내용이 바뀌지 않았으니 rev도 그대로다
    expect(doc.content).toBe("# 협업 문서");
    expect(await ipc.readFile(MOCK_ROOT, path)).toBe("# 협업 문서");
    expect(doc.externalRev).toBe(0);
    expect(isDirty(doc)).toBe(false);
  });

  it("markdown saveDoc strips a legacy synapse_id and bumps externalRev", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace
      .getState()
      .updateContent(path, "---\nsynapse_id: legacy-id-0001\n---\n\n# 협업 문서");

    await useWorkspace.getState().saveDoc(path);
    const doc = useWorkspace.getState().docs[path];
    // strip된 결과(id 제거)가 에디터 content에 반영되고 rev가 올라 에디터가 다시 그린다
    expect(doc.content).not.toContain("synapse_id");
    expect(doc.content).toContain("# 협업 문서");
    expect(doc.externalRev).toBe(1);
    expect(isDirty(doc)).toBe(false);
  });

  it("saveDoc clears externalStale on success", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(path, "# 편집 중 내용");
    // 이전 sync에서 배지가 세워졌다고 가정(실제로는 reloadAfterSync가 세운다)
    useWorkspace.setState((s) => ({
      docs: { ...s.docs, [path]: { ...s.docs[path], externalStale: true } },
    }));

    await useWorkspace.getState().saveDoc(path);
    expect(useWorkspace.getState().docs[path].externalStale).toBe(false);
  });

  it("saveDoc absorbs diverged disk via 3-way merge and reflects it in the editor", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    const base = useWorkspace.getState().docs[path].savedContent;

    // 외부(다른 기기 sync 병합 등)가 저장 사이에 디스크를 base에서 갈라놓는다
    await ipc.writeFile(MOCK_ROOT, path, `${base}\n외부-디스크-편집\n`);
    // 에디터는 별도의 편집을 갖고 있고, 이전 sync에서 배지가 세워졌다고 가정
    useWorkspace.getState().updateContent(path, `에디터-편집\n${base}`);
    useWorkspace.setState((s) => ({
      docs: { ...s.docs, [path]: { ...s.docs[path], externalStale: true } },
    }));

    await useWorkspace.getState().saveDoc(path);
    const doc = useWorkspace.getState().docs[path];
    // 덮어쓰지 않고 양쪽 편집을 모두 보존한 병합 결과가 에디터에 반영된다
    expect(doc.content).toContain("에디터-편집");
    expect(doc.content).toContain("외부-디스크-편집");
    expect(doc.content).toBe(doc.savedContent); // 저장 후 깨끗
    expect(doc.externalRev).toBe(1); // merged !== snapshot → 에디터 다시 그림
    expect(doc.externalStale).toBe(false); // 발산을 흡수했으니 배지 해제
    // 디스크에도 병합 결과가 쓰였다
    expect(await ipc.readFile(MOCK_ROOT, path)).toBe(doc.content);
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
    expect(doc.externalStale).toBe(false);
  });

  it("reloadAfterSync marks dirty docs externalStale without touching content (라이브 머지 없음)", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(path, "# 편집 중인 내용");
    // 그 사이 git sync가 디스크를 바꿔 놓은 상황을 모사 — 편집 중이라 자동 반영은 안 된다
    await ipc.writeFile(MOCK_ROOT, path, "# 원격에서 새로 합쳐진 내용 (dirty 케이스)");

    await useWorkspace.getState().reloadAfterSync();
    const doc = useWorkspace.getState().docs[path];
    // 라이브 머지가 없으니 편집 중이던 내용은 그대로다 — 배지만 세운다
    expect(doc.content).toBe("# 편집 중인 내용");
    expect(doc.externalStale).toBe(true);
    expect(isDirty(doc)).toBe(true);
  });

  it("reloadAfterSync does not badge a dirty doc when the disk is unchanged", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(path, "# 편집 중인 내용");
    // 디스크는 sync에서 바뀌지 않았다(savedContent 그대로) — 외부 변경 없음

    await useWorkspace.getState().reloadAfterSync();
    const doc = useWorkspace.getState().docs[path];
    expect(doc.externalStale).toBe(false);
    expect(doc.content).toBe("# 편집 중인 내용");
  });

  it("reloadAfterSync clears a leftover badge once the doc is clean and disk matches (undo 복귀, 디스크 무변경)", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    const original = useWorkspace.getState().docs[path].savedContent;
    useWorkspace.getState().updateContent(path, "# 편집 중인 내용"); // dirty
    // 이전 sync에서 세워진 배지가 남아 있는 상황 모사
    useWorkspace.setState((s) => ({
      docs: { ...s.docs, [path]: { ...s.docs[path], externalStale: true } },
    }));

    // 사용자가 undo로 원래 내용으로 복귀 → clean (저장은 발화하지 않는다)
    useWorkspace.getState().updateContent(path, original);
    expect(isDirty(useWorkspace.getState().docs[path])).toBe(false);

    // 디스크는 한 번도 바뀌지 않았다 → 발산 없음 → 배지를 내려야 한다
    await useWorkspace.getState().reloadAfterSync();
    const doc = useWorkspace.getState().docs[path];
    expect(doc.externalStale).toBe(false);
    expect(doc.content).toBe(original); // 내용은 건드리지 않는다
  });

  it("reloadAfterSync clears the badge on a dirty doc when disk already matches the editor content", async () => {
    await useWorkspace.getState().openFile(findNode("README.md"));
    const path = useWorkspace.getState().activePath!;
    useWorkspace.getState().updateContent(path, "# 편집 중인 내용"); // dirty
    useWorkspace.setState((s) => ({
      docs: { ...s.docs, [path]: { ...s.docs[path], externalStale: true } },
    }));
    // 원격이 같은 편집 결과를 이미 디스크에 반영해 둔 상황 — 발산 없음
    await ipc.writeFile(MOCK_ROOT, path, "# 편집 중인 내용");

    await useWorkspace.getState().reloadAfterSync();
    const doc = useWorkspace.getState().docs[path];
    expect(doc.externalStale).toBe(false);
    expect(doc.content).toBe("# 편집 중인 내용");
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

  describe("탭 이동·재열기 (커맨드 시스템)", () => {
    async function openThree(): Promise<string[]> {
      await useWorkspace.getState().openFile(findNode("README.md"));
      await useWorkspace.getState().openFile(findNode("2026-06-10.md"));
      await useWorkspace.getState().openFile(findNode("summary.html"));
      return useWorkspace.getState().tabs.map((t) => t.path);
    }

    it("nextTab/prevTab은 순환한다", async () => {
      const [a, b, c] = await openThree();
      expect(useWorkspace.getState().activePath).toBe(c);
      useWorkspace.getState().nextTab();
      expect(useWorkspace.getState().activePath).toBe(a); // 마지막→처음 순환
      useWorkspace.getState().prevTab();
      expect(useWorkspace.getState().activePath).toBe(c);
      useWorkspace.getState().setActiveTab(a);
      useWorkspace.getState().nextTab();
      expect(useWorkspace.getState().activePath).toBe(b);
    });

    it("탭이 1개 이하면 nextTab/prevTab은 no-op", async () => {
      await useWorkspace.getState().openFile(findNode("README.md"));
      const before = useWorkspace.getState().activePath;
      useWorkspace.getState().nextTab();
      useWorkspace.getState().prevTab();
      expect(useWorkspace.getState().activePath).toBe(before);
    });

    it("goToTab: 1-based, 9는 마지막, 범위 밖 no-op", async () => {
      const [a, , c] = await openThree();
      useWorkspace.getState().goToTab(1);
      expect(useWorkspace.getState().activePath).toBe(a);
      useWorkspace.getState().goToTab(9);
      expect(useWorkspace.getState().activePath).toBe(c);
      useWorkspace.getState().goToTab(5); // 탭 3개 — no-op
      expect(useWorkspace.getState().activePath).toBe(c);
    });

    it("closeTab은 recentlyClosed에 push하고 reopenClosedTab이 복원한다", async () => {
      const [, b] = await openThree();
      await useWorkspace.getState().closeTab(b);
      expect(useWorkspace.getState().recentlyClosed).toContain(b);
      await useWorkspace.getState().reopenClosedTab();
      const s = useWorkspace.getState();
      expect(s.tabs.some((t) => t.path === b)).toBe(true);
      expect(s.activePath).toBe(b);
      expect(s.recentlyClosed).not.toContain(b);
    });

    it("recentlyClosed는 중복 제거하고 최대 10개만 유지한다", async () => {
      const [a] = await openThree();
      for (let i = 0; i < 12; i++) {
        await useWorkspace.getState().openFile(findNode("README.md"));
        await useWorkspace.getState().closeTab(a);
      }
      const stack = useWorkspace.getState().recentlyClosed;
      expect(stack.filter((p) => p === a)).toHaveLength(1);
      expect(stack.length).toBeLessThanOrEqual(10);
    });

    it("트리에서 사라진 파일은 건너뛰고 다음 항목을 연다", async () => {
      const [a, b] = await openThree();
      await useWorkspace.getState().closeTab(a);
      await useWorkspace.getState().closeTab(b);
      // 마지막에 닫힌 b가 트리에서 사라졌다고 시뮬레이션
      useWorkspace.setState((s) => ({
        recentlyClosed: [...s.recentlyClosed.slice(0, -1), `${MOCK_ROOT}/ghost.md`],
      }));
      await useWorkspace.getState().reopenClosedTab();
      expect(useWorkspace.getState().tabs.some((t) => t.path === a)).toBe(true);
      expect(useWorkspace.getState().recentlyClosed).toHaveLength(0);
    });
  });
});
