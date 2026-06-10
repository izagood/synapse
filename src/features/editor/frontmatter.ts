// YAML frontmatter 보존 (FR-2.9의 1단계: 파싱은 하지 않고 원문 그대로 분리/재결합)
// 에디터는 본문만 다루고, 저장 시 frontmatter를 그대로 앞에 붙인다.

export interface SplitDocument {
  /** 구분선을 포함한 frontmatter 원문 (없으면 null). 항상 본문과 빈 줄로 구분되는 형태로 보관 */
  frontmatter: string | null;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): SplitDocument {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: text };
  const frontmatter = match[0].trimEnd();
  const body = text.slice(match[0].length).replace(/^\r?\n/, "");
  return { frontmatter, body };
}

export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (!frontmatter) return body;
  return `${frontmatter}\n\n${body}`;
}
