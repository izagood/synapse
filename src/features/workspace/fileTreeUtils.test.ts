import { describe, expect, it } from "vitest";
import { ancestorDirsOf, clampMenuPosition, findNode, isDeleteShortcut } from "./fileTreeUtils";
import type { FileNode } from "../../ipc/types";

describe("clampMenuPosition", () => {
  // 메뉴 180x220, 뷰포트 800x600 기준
  const clamp = (x: number, y: number) => clampMenuPosition(x, y, 180, 220, 800, 600);

  it("뷰포트 안이면 좌표를 그대로 둔다", () => {
    expect(clamp(100, 100)).toEqual({ x: 100, y: 100 });
  });

  it("하단에서 메뉴가 짤리면 위로 밀어 넣는다", () => {
    expect(clamp(100, 550)).toEqual({ x: 100, y: 600 - 220 - 4 });
  });

  it("우측에서 메뉴가 짤리면 왼쪽으로 밀어 넣는다", () => {
    expect(clamp(750, 100)).toEqual({ x: 800 - 180 - 4, y: 100 });
  });

  it("우하단 모서리에서는 양쪽 모두 보정한다", () => {
    expect(clamp(790, 590)).toEqual({ x: 800 - 180 - 4, y: 600 - 220 - 4 });
  });

  it("메뉴가 뷰포트보다 커도 음수 좌표 대신 최소 여백을 지킨다", () => {
    expect(clampMenuPosition(10, 10, 900, 700, 800, 600)).toEqual({ x: 4, y: 4 });
  });
});

describe("findNode", () => {
  const tree: FileNode = {
    name: "root",
    path: "/ws",
    kind: "dir",
    fileType: "other",
    children: [
      {
        name: "docs",
        path: "/ws/docs",
        kind: "dir",
        fileType: "other",
        children: [
          { name: "a.md", path: "/ws/docs/a.md", kind: "file", fileType: "markdown" },
        ],
      },
      { name: "b.md", path: "/ws/b.md", kind: "file", fileType: "markdown" },
    ],
  };

  it("중첩된 노드를 경로로 찾는다", () => {
    expect(findNode(tree, "/ws/docs/a.md")?.name).toBe("a.md");
    expect(findNode(tree, "/ws/docs")?.kind).toBe("dir");
  });

  it("없는 경로는 null", () => {
    expect(findNode(tree, "/ws/nope.md")).toBeNull();
  });
});

describe("ancestorDirsOf", () => {
  it("중첩 파일의 조상 디렉터리를 루트 제외 바깥→안 순서로 반환한다", () => {
    expect(ancestorDirsOf("/ws", "/ws/AI/backend/n.md")).toEqual([
      "/ws/AI",
      "/ws/AI/backend",
    ]);
  });

  it("루트 직속 파일은 빈 배열", () => {
    expect(ancestorDirsOf("/ws", "/ws/n.md")).toEqual([]);
  });

  it("루트 밖 경로는 빈 배열", () => {
    expect(ancestorDirsOf("/ws", "/other/n.md")).toEqual([]);
    // prefix가 우연히 겹치는 형제 경로도 루트 밖이다
    expect(ancestorDirsOf("/ws", "/ws2/n.md")).toEqual([]);
  });

  it("루트에 trailing slash가 있어도 동일하게 동작한다", () => {
    expect(ancestorDirsOf("/ws/", "/ws/AI/n.md")).toEqual(["/ws/AI"]);
  });
});

describe("isDeleteShortcut", () => {
  it("Cmd+Backspace / Ctrl+Delete 를 인식한다", () => {
    expect(isDeleteShortcut({ metaKey: true, ctrlKey: false, key: "Backspace" })).toBe(true);
    expect(isDeleteShortcut({ metaKey: false, ctrlKey: true, key: "Delete" })).toBe(true);
  });

  it("수식키 없는 Backspace나 다른 키 조합은 무시한다", () => {
    expect(isDeleteShortcut({ metaKey: false, ctrlKey: false, key: "Backspace" })).toBe(false);
    expect(isDeleteShortcut({ metaKey: true, ctrlKey: false, key: "a" })).toBe(false);
  });
});
