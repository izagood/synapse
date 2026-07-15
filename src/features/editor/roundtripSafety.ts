import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token";

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: false,
});

type Signature = {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  attrs: [string, string][];
  children: Signature[];
};

const CONTENT_TYPES = new Set([
  "code_block",
  "code_inline",
  "fence",
  "html_block",
  "html_inline",
  "text",
]);

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeText(value: string): string {
  return normalizeLineEndings(value).replace(/\s+/g, " ").trim();
}

function normalizeCode(value: string): string {
  return normalizeLineEndings(value).replace(/\n+$/g, "");
}

function normalizeHtml(value: string): string {
  return normalizeText(value.replace(/>\s+/g, ">").replace(/\s+</g, "<"));
}

function normalizeUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function normalizeAttr(name: string, value: string): [string, string] {
  if (name === "href" || name === "src") return [name, normalizeUrl(value)];
  return [name, normalizeText(value)];
}

function normalizedContent(token: Token): string {
  if (token.type === "fence") {
    const info = normalizeText(token.info);
    const content = normalizeCode(token.content);
    return info ? `${info}\n${content}` : content;
  }
  if (token.type === "code_block" || token.type === "code_inline") {
    return normalizeCode(token.content);
  }
  if (token.type === "html_block" || token.type === "html_inline") {
    return normalizeHtml(token.content);
  }
  if (CONTENT_TYPES.has(token.type)) {
    return normalizeText(token.content);
  }
  return "";
}

function tokenSignature(token: Token): Signature | null {
  if (token.hidden || token.type === "softbreak") return null;

  return {
    type: token.type,
    tag: token.tag,
    nesting: token.nesting,
    content: normalizedContent(token),
    attrs: (token.attrs ?? []).map(([name, value]) => normalizeAttr(name, value)).sort(),
    children: (token.children ?? [])
      .map(tokenSignature)
      .filter((child): child is Signature => child !== null),
  };
}

/** top-level 블록 하나의 의미 시그니처와 원본에서의 소스 라인 범위. */
export type BlockSignature = {
  /** 블록 토큰 서브트리의 정규화 시그니처(JSON). 의미가 같으면 문자열이 같다. */
  sig: string;
  /** 원본 본문에서의 시작 라인 (0-indexed). */
  startLine: number;
  /** 끝 라인 (exclusive). */
  endLine: number;
};

// markdown-it 토큰 스트림을 top-level 블록으로 그룹화한다.
// 컨테이너(nesting=1)는 같은 level의 close(nesting=-1)까지, 자기완결 토큰
// (nesting=0: fence/hr/html_block 등)은 그 하나가 한 블록이다.
export function blockSignatures(markdown: string): BlockSignature[] {
  const tokens = md.parse(normalizeLineEndings(markdown), {});
  const blocks: BlockSignature[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    if (tokens[i].nesting === 1) {
      i++;
      while (i < tokens.length && !(tokens[i].level === 0 && tokens[i].nesting === -1)) i++;
      i++; // 닫는 토큰 포함
    } else {
      i++; // 자기완결 토큰 또는 홀로 남은 close
    }
    const group = tokens.slice(start, i);
    const sigs = group
      .map(tokenSignature)
      .filter((s): s is Signature => s !== null);
    if (sigs.length === 0) continue;
    let startLine = Infinity;
    let endLine = -Infinity;
    for (const t of group) {
      if (t.map) {
        startLine = Math.min(startLine, t.map[0]);
        endLine = Math.max(endLine, t.map[1]);
      }
    }
    if (!Number.isFinite(startLine)) continue; // 위치 정보 없는 블록은 건너뛴다
    blocks.push({ sig: JSON.stringify(sigs), startLine, endLine });
  }
  return blocks;
}

export function hasRoundtripContentLoss(original: string, serialized: string): boolean {
  if (normalizeLineEndings(original) === normalizeLineEndings(serialized)) return false;
  const a = blockSignatures(original).map((b) => b.sig);
  const b = blockSignatures(serialized).map((b) => b.sig);
  return JSON.stringify(a) !== JSON.stringify(b);
}
