import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./workspace";
import type { FileNode } from "../ipc/types";

// node 환경에서는 ipc가 자동으로 mockIpc로 동작한다 (인메모리 워크스페이스)
const MOCK_ROOT = "/mock/notes";

function nodeByPath(path: string): FileNode | null {
  const walk = (n: FileNode | null): FileNode | null => {
    if (!n) return null;
    if (n.path === path) return n;
    for (const c of n.children ?? []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  };
  return walk(useWorkspace.getState().tree);
}

describe("workspace DnD: moveEntry / importExternalFiles", () => {
  beforeEach(async () => {
    useWorkspace.getState().closeWorkspace();
    await useWorkspace.getState().openFolder(MOCK_ROOT);
  });

  // 한 테스트에서 이동 결과와 "열린 파일 재오픈"을 함께 검증한다.
  // (mock files 맵이 파일 내 테스트끼리 공유되므로 README를 두 번 옮기지 않는다)
  it("열린 파일을 다른 폴더로 이동하면 새 경로 탭으로 다시 연다", async () => {
    const src = `${MOCK_ROOT}/README.md`;
    expect(nodeByPath(src)).not.toBeNull();
    await useWorkspace.getState().openFile({
      path: src,
      name: "README.md",
      kind: "file",
      fileType: "markdown",
    });
    expect(useWorkspace.getState().activePath).toBe(src);

    await useWorkspace.getState().moveEntry(src, `${MOCK_ROOT}/daily`);

    const s = useWorkspace.getState();
    const dest = `${MOCK_ROOT}/daily/README.md`;
    expect(nodeByPath(src)).toBeNull(); // 원래 위치엔 없음
    expect(nodeByPath(dest)).not.toBeNull(); // 옮긴 위치에 있음
    expect(s.activePath).toBe(dest); // 새 경로 탭으로 재오픈
    expect(s.tabs.some((t) => t.path === dest)).toBe(true);
    expect(s.tabs.some((t) => t.path === src)).toBe(false);
    expect(s.error).toBeNull();
  });

  it("이미 그 폴더에 있으면 무동작", async () => {
    const src = `${MOCK_ROOT}/daily/2026-06-10.md`;
    await useWorkspace.getState().moveEntry(src, `${MOCK_ROOT}/daily`);
    expect(nodeByPath(src)).not.toBeNull(); // 그대로
    expect(useWorkspace.getState().error).toBeNull();
  });

  it("폴더를 자기 하위로는 옮기지 않는다(가드)", async () => {
    const src = `${MOCK_ROOT}/daily`;
    await useWorkspace.getState().moveEntry(src, `${MOCK_ROOT}/daily/deeper`);
    // 가드에 막혀 트리가 그대로 유지된다
    expect(nodeByPath(src)).not.toBeNull();
    expect(nodeByPath(`${MOCK_ROOT}/daily/2026-06-10.md`)).not.toBeNull();
  });

  it("외부 파일을 폴더로 가져온다", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "imported.png", {
      type: "image/png",
    });
    await useWorkspace.getState().importExternalFiles(`${MOCK_ROOT}/assets`, [file]);

    expect(nodeByPath(`${MOCK_ROOT}/assets/imported.png`)).not.toBeNull();
    expect(useWorkspace.getState().error).toBeNull();
  });

  it("같은 이름이 있으면 충돌을 비켜 가져온다", async () => {
    const mk = () =>
      new File([new Uint8Array([9])], "dup.bin", { type: "application/octet-stream" });
    await useWorkspace.getState().importExternalFiles(`${MOCK_ROOT}/assets`, [mk()]);
    await useWorkspace.getState().importExternalFiles(`${MOCK_ROOT}/assets`, [mk()]);

    expect(nodeByPath(`${MOCK_ROOT}/assets/dup.bin`)).not.toBeNull();
    expect(nodeByPath(`${MOCK_ROOT}/assets/dup 2.bin`)).not.toBeNull();
  });
});
