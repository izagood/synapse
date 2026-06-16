import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

// 본문 속 맨 URL(bare URL)을 클릭 가능한 링크로 만든다.
// 문서 모델은 건드리지 않고 화면에만 <a> 데코레이션을 입히므로 md 직렬화에는
// 영향이 없다 — 원본 텍스트(맨 URL 그대로)가 보존된다.
// 클릭 처리는 MarkdownEditor의 handleClick(href가 http(s)면 시스템 브라우저)이 맡는다.

export type UrlMatch = { url: string; start: number; end: number };

// http(s) 스킴으로 시작하는 URL. 공백/괄호/꺾쇠는 경계로 본다.
const URL_RE = /https?:\/\/[^\s<>()]+/gi;

// URL 뒤에 붙은 문장 부호는 링크에서 제외한다. (예: "...edit?tab=t.0)" 의 닫는 괄호)
function trimTrailing(url: string): string {
  return url.replace(/[.,;:!?'"]+$/, "");
}

// 주어진 텍스트에서 맨 URL들의 위치를 찾는다 (테스트 가능한 순수 함수).
export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = trimTrailing(m[0]);
    if (!url) continue;
    matches.push({ url, start: m.index, end: m.index + url.length });
  }
  return matches;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    // 코드 블록 내부는 링크화하지 않는다
    if (parent?.type.spec.code) return false;
    if (!node.isText || !node.text) return;
    // 이미 링크/인라인 코드 마크가 붙은 텍스트는 건너뛴다
    if (node.marks.some((mark) => mark.type.name === "link" || mark.type.name === "code")) {
      return;
    }
    for (const { url, start, end } of findUrls(node.text)) {
      decorations.push(
        Decoration.inline(pos + start, pos + end, {
          nodeName: "a",
          href: url,
          class: "autolink",
          rel: "noopener noreferrer",
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

const linkifyPluginKey = new PluginKey("linkifyUrls");

export const LinkifyUrls = Extension.create({
  name: "linkifyUrls",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: linkifyPluginKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
