import type { FileNode } from "../../ipc/types";

export interface QuickOpenItem {
  node: FileNode;
  /** 워크스페이스 루트 기준 상대 경로 */
  relPath: string;
}

export function flattenFiles(tree: FileNode | null): QuickOpenItem[] {
  if (!tree) return [];
  const rootPrefix = `${tree.path}/`;
  const items: QuickOpenItem[] = [];
  const walk = (node: FileNode) => {
    if (node.kind === "file") {
      items.push({ node, relPath: node.path.replace(rootPrefix, "") });
    }
    node.children?.forEach(walk);
  };
  tree.children?.forEach(walk);
  return items;
}

/**
 * VSCode 스타일 부분 문자열 퍼지 매칭.
 * 쿼리의 각 문자가 순서대로 등장하면 매치. 점수: 연속 매치와
 * 경로 마지막 구획(파일명) 매치를 우대, 최근에 가까운(짧은) 경로 우대.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  const nameStart = t.lastIndexOf("/") + 1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += found === lastMatch + 1 ? 3 : 1; // 연속 보너스
    if (found >= nameStart) score += 2; // 파일명 영역 보너스
    lastMatch = found;
    ti = found + 1;
  }
  return score - t.length * 0.01; // 짧은 경로 우대
}

export function filterQuickOpen(
  items: QuickOpenItem[],
  query: string,
  limit = 50,
): QuickOpenItem[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query.trim(), item.relPath) }))
    .filter((x): x is { item: QuickOpenItem; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
