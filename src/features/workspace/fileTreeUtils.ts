import type { FileNode } from "../../ipc/types";

/**
 * 컨텍스트 메뉴가 뷰포트 밖으로 넘치지 않도록 좌표를 보정한다.
 * 하단/우측에서 메뉴가 짤려 '삭제' 등을 누를 수 없던 문제 방지.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin)),
  };
}

/** 트리에서 경로가 일치하는 노드를 깊이 우선으로 찾는다 */
export function findNode(node: FileNode, path: string): FileNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

/** Cmd/Ctrl+Backspace(또는 Delete)가 "선택 파일 삭제" 단축키인지 판정한다 */
export function isDeleteShortcut(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
}): boolean {
  return (e.metaKey || e.ctrlKey) && (e.key === "Backspace" || e.key === "Delete");
}
