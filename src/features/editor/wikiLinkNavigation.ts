import type { FileNode } from "../../ipc/types";

export interface WikiTargetResult {
  path: string;
  ambiguous: boolean;
}

function collectFileNodes(node: FileNode, acc: FileNode[]): void {
  if (node.kind === "file" && node.fileType === "markdown") {
    acc.push(node);
  }
  if (node.children) {
    for (const child of node.children) {
      collectFileNodes(child, acc);
    }
  }
}

function stemOf(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

/** 트리 한 그루당 한 번만 만든 stem 인덱스를 재사용한다. 위키링크 클릭마다
 *  전체 트리를 다시 순회하면 큰 볼트(스트레스 하네스 기준 10만 노트)에서
 *  클릭이 눈에 띄게 느려진다. 트리 객체가 바뀌면(refreshTree) 자동 무효화된다. */
const stemIndexCache = new WeakMap<FileNode, Map<string, { path: string; count: number }>>();

function stemIndexOf(tree: FileNode): Map<string, { path: string; count: number }> {
  const cached = stemIndexCache.get(tree);
  if (cached) return cached;
  const built = buildStemIndex(tree);
  stemIndexCache.set(tree, built);
  return built;
}

function buildStemIndex(
  tree: FileNode,
): Map<string, { path: string; count: number }> {
  const files: FileNode[] = [];
  collectFileNodes(tree, files);

  const index = new Map<string, { path: string; count: number }>();
  for (const file of files) {
    const stem = stemOf(file.name).toLowerCase();
    const existing = index.get(stem);
    if (existing) {
      existing.count += 1;
    } else {
      index.set(stem, { path: file.path, count: 1 });
    }
  }
  return index;
}

function parseWikiTarget(inner: string): { target: string; alias: string | null } {
  const aliasSep = inner.indexOf("|");
  const alias = aliasSep >= 0 ? inner.slice(aliasSep + 1) : null;
  const targetWithAnchor = aliasSep >= 0 ? inner.slice(0, aliasSep) : inner;
  const anchorSep = targetWithAnchor.indexOf("#");
  const target = anchorSep >= 0
    ? targetWithAnchor.slice(0, anchorSep)
    : targetWithAnchor;
  return { target: target.trim(), alias };
}

/** `[[대상|별칭#앵커]]`의 대상을 vault 안 노트 경로로 해석한다.
 *  규칙은 Rust `links.rs`의 `wiki_target`/`stem_index`와 맞춘다 —
 *  별칭(`|`)·앵커(`#`) 앞까지만 보고, stem을 소문자로 비교한다.
 *  같은 stem이 여럿이면 `ambiguous`로 표시해 호출자가 이동을 포기하게 한다
 *  (엉뚱한 노트로 보내는 것보다 아무 일도 안 하는 편이 낫다). */
export function resolveWikiTarget(
  inner: string,
  tree: FileNode,
): WikiTargetResult | null {
  if (!inner || !tree) return null;

  const { target } = parseWikiTarget(inner);
  if (!target) return null;

  const entry = stemIndexOf(tree).get(target.toLowerCase());

  if (!entry) return null;
  if (entry.count > 1) return { path: entry.path, ambiguous: true };

  return { path: entry.path, ambiguous: false };
}