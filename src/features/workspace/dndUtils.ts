// 파일 트리 드래그앤드롭의 순수 로직. UI/Tauri 의존 없이 단위 테스트한다.
import type { FileNode } from "../../ipc/types";
import { dirname } from "../../shared/pathUtils";

/** 내부(앱 안) 파일/폴더 드래그를 외부 OS 파일 드롭과 구분하는 커스텀 타입 */
export const SYNAPSE_DND_MIME = "application/x-synapse-path";

/**
 * 드롭 대상 노드로부터 "넣을 폴더" 경로를 고른다.
 * - 폴더에 드롭하면 그 폴더
 * - 파일에 드롭하면 그 파일이 든 폴더(부모)
 * - 노드가 없으면(트리 빈 영역) 루트
 */
export function dropTargetDir(node: FileNode | null, root: string): string {
  if (!node) return root;
  return node.kind === "dir" ? node.path : dirname(node.path);
}

/**
 * 내부 이동이 무의미하거나 불가능한지 판단한다(드롭 직전 가드).
 * - 이미 그 폴더에 있음(부모가 곧 대상): 무동작
 * - 자기 자신 / 자기 하위 폴더로의 이동: 트리가 끊겨 불가
 */
export function isRedundantOrInvalidMove(srcPath: string, destDir: string): boolean {
  if (destDir === srcPath) return true; // 폴더를 자기 자신 안으로
  if (destDir.startsWith(`${srcPath}/`)) return true; // 폴더를 자기 하위로
  return dirname(srcPath) === destDir; // 이미 그 폴더에 있음
}

/**
 * DataTransfer가 앱 내부 드래그를 담고 있는지(이동) 외부 OS 파일인지(가져오기)
 * dragover 시점에 판별한다. dragover 단계에선 getData가 막혀 있어 types 만 본다.
 */
export function dndKind(types: readonly string[]): "move" | "import" | null {
  if (types.includes(SYNAPSE_DND_MIME)) return "move";
  if (types.includes("Files")) return "import";
  return null;
}
