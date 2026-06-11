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

/**
 * root 기준으로 filePath의 조상 디렉터리 절대 경로 목록 (루트 제외, 바깥→안 순).
 * 예: root=/ws, file=/ws/AI/backend/n.md → ["/ws/AI", "/ws/AI/backend"]
 * filePath가 root 밖이거나 root 직속이면 [].
 */
export function ancestorDirsOf(root: string, filePath: string): string[] {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (!filePath.startsWith(`${base}/`)) return [];
  const parts = filePath.slice(base.length + 1).split("/");
  const dirs: string[] = [];
  let cur = base;
  for (const part of parts.slice(0, -1)) {
    cur = `${cur}/${part}`;
    dirs.push(cur);
  }
  return dirs;
}

/** Cmd/Ctrl+Backspace(또는 Delete)가 "선택 파일 삭제" 단축키인지 판정한다 */
export function isDeleteShortcut(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
}): boolean {
  return (e.metaKey || e.ctrlKey) && (e.key === "Backspace" || e.key === "Delete");
}
