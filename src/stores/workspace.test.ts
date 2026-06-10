import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./workspace";

// node 환경에서는 ipc가 자동으로 mockIpc로 동작한다 (src/ipc/ipc.ts의 isTauri 분기)
const MOCK_ROOT = "/mock/notes";

describe("workspace store (mock ipc)", () => {
  beforeEach(() => {
    useWorkspace.getState().closeWorkspace();
  });

  it("opens a folder: tree loaded and recorded in recent", async () => {
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    const s = useWorkspace.getState();
    expect(s.root).toBe(MOCK_ROOT);
    expect(s.tree?.kind).toBe("dir");
    expect(s.tree?.children?.length).toBeGreaterThan(0);
    expect(s.recent[0]).toBe(MOCK_ROOT);
    expect(s.error).toBeNull();
  });

  it("selects a markdown file and loads its content", async () => {
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    const readme = useWorkspace
      .getState()
      .tree!.children!.find((n) => n.name === "README.md")!;
    await useWorkspace.getState().selectFile(readme);
    const s = useWorkspace.getState();
    expect(s.selectedPath).toBe(readme.path);
    expect(s.fileContent).toContain("Mock 워크스페이스");
  });

  it("ignores selecting a directory", async () => {
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    const dir = useWorkspace
      .getState()
      .tree!.children!.find((n) => n.kind === "dir")!;
    await useWorkspace.getState().selectFile(dir);
    expect(useWorkspace.getState().selectedPath).toBeNull();
  });

  it("surfaces errors for an invalid folder", async () => {
    await useWorkspace.getState().openFolder("/does/not/exist");
    const s = useWorkspace.getState();
    expect(s.root).toBeNull();
    expect(s.error).toContain("not a directory");
  });

  it("closeWorkspace returns to start state", async () => {
    await useWorkspace.getState().openFolder(MOCK_ROOT);
    useWorkspace.getState().closeWorkspace();
    const s = useWorkspace.getState();
    expect(s.root).toBeNull();
    expect(s.tree).toBeNull();
  });
});
