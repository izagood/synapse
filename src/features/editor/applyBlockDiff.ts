import type { Editor } from "@tiptap/core";
import { DOMParser as PMDOMParser, type Node as PMNode } from "@tiptap/pm/model";

// tiptap-markdown(es) 내부 헬퍼와 동일: html 문자열을 <body> 요소로 만든다.
function elementFromString(html: string): HTMLElement {
  return new window.DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
}

// 마크다운을 "라이브 에디터의 schema"로 파싱한 문서를 돌려준다.
// (별도 에디터로 파싱하면 schema 인스턴스가 달라 node.eq 비교와 노드 삽입이
//  깨지므로, 반드시 editor.schema로 DOMParse 한다.)
export function parseMarkdownToDoc(editor: Editor, md: string): PMNode {
  const storage = editor.storage as unknown as {
    markdown: { parser: { parse(content: string): string } };
  };
  const html = storage.markdown.parser.parse(md);
  const element = elementFromString(html);
  return PMDOMParser.fromSchema(editor.schema).parse(element);
}

export type BlockHunk = { from: number; to: number; nodes: PMNode[] };

// 두 문서의 최상위(블록) 노드 배열을 node.eq 기반 LCS로 비교해, 변경된 run을
// hunk로 낸다. from/to는 oldDoc 안의 블록 경계 위치(doc 좌표).
export function diffTopLevelBlocks(oldDoc: PMNode, newDoc: PMNode): BlockHunk[] {
  const olds: PMNode[] = [];
  oldDoc.forEach((n) => olds.push(n));
  const news: PMNode[] = [];
  newDoc.forEach((n) => news.push(n));

  // old child i의 시작 위치(doc 좌표). child0 시작 = 0.
  const starts: number[] = [];
  let pos = 0;
  for (const n of olds) {
    starts.push(pos);
    pos += n.nodeSize;
  }
  const oldEnd = pos;
  const startAt = (i: number) => (i < starts.length ? starts[i] : oldEnd);

  // LCS 길이표 (node.eq 동치). m,n 작을 것이므로 O(mn)로 충분.
  const m = olds.length;
  const n = news.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = olds[i].eq(news[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // 매칭 쌍 추출
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (olds[i].eq(news[j])) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // 매칭 사이/앞뒤의 비매칭 gap을 hunk로
  const hunks: BlockHunk[] = [];
  let oi = 0;
  let nj = 0;
  const pushGap = (oEnd: number, nEnd: number) => {
    if (oEnd > oi || nEnd > nj) {
      hunks.push({ from: startAt(oi), to: startAt(oEnd), nodes: news.slice(nj, nEnd) });
    }
  };
  for (const [mo, mn] of matches) {
    pushGap(mo, mn);
    oi = mo + 1;
    nj = mn + 1;
  }
  pushGap(m, n);
  return hunks;
}
