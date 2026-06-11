// 에이전트 응답을 가볍고 "안전하게" 마크다운으로 렌더링하기 위한 순수 파서.
// 원시 HTML은 절대 해석하지 않는다(텍스트로 취급) — 신뢰 경계를 넘지 않는다.
// 풀스펙 마크다운이 아니라 채팅 응답에 흔한 요소만 다룬다:
//   - 펜스 코드블록 ```lang ... ```
//   - 헤딩 #..######
//   - 순서/비순서 목록 (-, *, +, 1.)
//   - 인용 >
//   - 문단
//   - 인라인: **bold**, *italic*/_italic_, `code`, [text](url)

export interface InlineText {
  type: "text";
  value: string;
}
export interface InlineBold {
  type: "bold";
  value: string;
}
export interface InlineItalic {
  type: "italic";
  value: string;
}
export interface InlineCode {
  type: "code";
  value: string;
}
export interface InlineLink {
  type: "link";
  text: string;
  href: string;
}
export type Inline =
  | InlineText
  | InlineBold
  | InlineItalic
  | InlineCode
  | InlineLink;

export interface CodeBlock {
  type: "code";
  lang: string | null;
  value: string;
}
export interface Heading {
  type: "heading";
  level: number;
  children: Inline[];
}
export interface Paragraph {
  type: "paragraph";
  children: Inline[];
}
export interface Quote {
  type: "quote";
  children: Inline[];
}
export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: Inline[][];
}
export type Block = CodeBlock | Heading | Paragraph | Quote | ListBlock;

/** http/https/mailto만 안전한 링크로 본다. 그 외(javascript: 등)는 거부. */
export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

/** 인라인 마크업을 토큰 배열로 분해한다. 인식 못한 마크업은 텍스트로 남는다. */
export function parseInline(input: string): Inline[] {
  const out: Inline[] = [];
  let rest = input;
  // 토큰 우선순위: code > link > bold > italic
  const patterns: { re: RegExp; make: (m: RegExpExecArray) => Inline | null }[] = [
    { re: /`([^`]+)`/, make: (m) => ({ type: "code", value: m[1] }) },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)/,
      make: (m) =>
        isSafeHref(m[2]) ? { type: "link", text: m[1], href: m[2].trim() } : null,
    },
    { re: /\*\*([^*]+)\*\*/, make: (m) => ({ type: "bold", value: m[1] }) },
    { re: /\*([^*]+)\*/, make: (m) => ({ type: "italic", value: m[1] }) },
    { re: /_([^_]+)_/, make: (m) => ({ type: "italic", value: m[1] }) },
  ];

  while (rest.length > 0) {
    let best: { index: number; length: number; node: Inline } | null = null;
    for (const { re, make } of patterns) {
      const m = re.exec(rest);
      if (!m) continue;
      const node = make(m);
      if (!node) continue; // 안전하지 않은 링크 등 — 이 패턴은 건너뛴다
      if (best === null || m.index < best.index) {
        best = { index: m.index, length: m[0].length, node };
      }
    }
    if (!best) {
      out.push({ type: "text", value: rest });
      break;
    }
    if (best.index > 0) {
      out.push({ type: "text", value: rest.slice(0, best.index) });
    }
    out.push(best.node);
    rest = rest.slice(best.index + best.length);
  }
  return out;
}

/** 마크다운 텍스트를 블록 배열로 파싱한다. */
export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    blocks.push({ type: "paragraph", children: parseInline(buf.join(" ")) });
    buf.length = 0;
  };

  const paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // 펜스 코드블록
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const lang = fence[1].trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 닫는 펜스 건너뛰기 (없으면 끝까지)
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    // 빈 줄 → 문단 경계
    if (line.trim() === "") {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    // 헤딩
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2].trim()),
      });
      i++;
      continue;
    }

    // 인용
    if (/^>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(quoteLines.join(" ")) });
      continue;
    }

    // 목록
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph(paragraph);
      const ordered = /\d+\./.test(listMatch[2]);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const isOrdered = /\d+\./.test(m[2]);
        if (isOrdered !== ordered) break;
        items.push(parseInline(m[3]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 일반 문단 줄 누적
    paragraph.push(line.trim());
    i++;
  }
  flushParagraph(paragraph);
  return blocks;
}
