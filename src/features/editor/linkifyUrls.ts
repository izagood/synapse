import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

// 본문 속 맨 URL(bare URL)을 클릭 가능한 링크로 만든다.
// 문서 모델은 건드리지 않고 화면에만 <a> 데코레이션을 입히므로 md 직렬화에는
// 영향이 없다 — 원본 텍스트(맨 URL 그대로)가 보존된다.
// 클릭 처리는 MarkdownEditor의 handleClick(href가 http(s)면 시스템 브라우저)이 맡는다.

export type UrlMatch = { url: string; start: number; end: number };

// http(s) 스킴으로 시작하는 URL. 공백/꺾쇠와 전각 문장부호를 경계로 본다.
// 괄호는 경계에서 뺐다 — URL 경로에 정당하게 들어가기 때문이다
// (위키백과의 `.../Rust_(programming_language)`가 `.../Rust_`로 잘리던 문제).
// 대신 짝이 맞지 않는 닫는 괄호만 trimTrailing이 떼어낸다.
// 전각 문장부호(。、…)와 전각 공백은 URL에 쓰이지 않고 한국어·일본어 본문에서
// URL 바로 뒤에 붙으므로 여기서 잘라야 한다(뒤에 글자가 이어지면 trimTrailing
// 으로는 못 떼어낸다 — "https://ex.com、다음").
// 전각 공백(U+3000)은 소스에 그대로 쓰면 눈에 보이지 않으므로 이스케이프로 쓴다.
const URL_RE = /https?:\/\/[^\s<>\u3000、。…]+/gi;

// 닫는 괄호류 → 짝이 되는 여는 괄호. 백틱은 짝 개념이 없어 자기 자신을 가리킨다.
const CLOSERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "»": "«",
  "`": "`",
};

// URL 뒤에 붙은 문장 부호는 링크에서 제외한다. (예: "...edit?tab=t.0)" 의 닫는 괄호)
// 닫는 괄호는 짝이 맞는지 보고 판단한다: "(https://ex.com/a)"의 ")"는 본문 괄호라
// 떼어내야 하지만 ".../Rust_(programming_language)"의 ")"는 URL의 일부다.
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const trimmed = out.replace(/[.,;:!?'"]+$/, "");
    if (trimmed !== out) {
      out = trimmed;
      continue;
    }
    const last = out[out.length - 1];
    const open = last ? CLOSERS[last] : undefined;
    if (!open) break;
    // 여는 괄호가 URL 안에 그만큼 있으면 짝이 맞는다 — URL의 일부로 남긴다.
    // 백틱(open === last)은 짝을 셀 수 없으므로 항상 떼어낸다.
    if (open !== last) {
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (opens >= closes) break;
    }
    out = out.slice(0, -1);
  }
  return out;
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
