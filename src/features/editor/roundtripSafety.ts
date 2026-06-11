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

function markdownSignature(markdown: string): Signature[] {
  return md
    .parse(normalizeLineEndings(markdown), {})
    .map(tokenSignature)
    .filter((token): token is Signature => token !== null);
}

export function hasRoundtripContentLoss(original: string, serialized: string): boolean {
  if (normalizeLineEndings(original) === normalizeLineEndings(serialized)) return false;
  return JSON.stringify(markdownSignature(original)) !== JSON.stringify(markdownSignature(serialized));
}
