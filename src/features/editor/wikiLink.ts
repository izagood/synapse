import { Node, mergeAttributes } from "@tiptap/core";
import type MarkdownIt from "markdown-it";

// 위키링크 `[[대상]]` 을 1급 노드로 다룬다.
//
// 왜 필요한가: 노드가 없으면 `[[대상]]` 은 평문 text 로 들어가고,
// prosemirror-markdown 의 esc() 가 `[` 를 이스케이프해 `\[\[대상\]\]` 로 저장한다.
// 그러면 crates/synapse-core/src/links.rs 의 파서(리터럴 '[' 를 요구)가
// 더 이상 링크로 인식하지 못한다 — autolink.rs 가 쓴 `[[stem]]` 을
// 에디터가 깨뜨리고 앱 자신이 못 읽는 자기모순이 된다.
//
// 대상 문자열은 **원문 그대로**(inner) 보관한다. 별칭(`|`)·앵커(`#`)를 쪼개
// 재조립하면 순서·공백이 바뀌어 바이트가 달라질 수 있다. 파싱은 Rust 쪽
// wiki_target 이 담당하므로 에디터는 원문 보존만 책임진다.

/** `[[` 와 `]]` 사이의 원문. 이 값을 그대로 다시 써서 바이트 동일을 보장한다. */
export type WikiLinkAttrs = { inner: string };

/** 위키링크로 인정하는 내부 문자열인가. Rust links.rs 의 스캔 규칙과 맞춘다. */
export function isValidWikiInner(inner: string): boolean {
  if (inner.length === 0) return false;
  // 개행이 들어가면 인라인 링크가 아니다. `[` 는 중첩으로 오해되므로 제외한다.
  if (inner.includes("\n") || inner.includes("[") || inner.includes("]")) return false;
  return true;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// markdown-it 인라인 규칙: `[[...]]` 를 전용 토큰으로 잡는다.
// `link` 규칙보다 먼저 등록해야 `[` 하나짜리 표준 링크에 뺏기지 않는다.
function wikiLinkRule(state: MarkdownItInlineState, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) return false;

  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;

  const inner = src.slice(pos + 2, end);
  if (!isValidWikiInner(inner)) return false;

  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.content = inner;
    token.markup = "[[";
  }
  state.pos = end + 2;
  return true;
}

// markdown-it 은 tiptap-markdown 안에서 "마크다운 → HTML → DOM → ProseMirror"
// 순으로 흐른다. 따라서 토큰만 만들면 안 되고, parseHTML 이 알아볼 수 있는
// HTML 을 내보내는 렌더러 규칙까지 등록해야 한다.
// DOMParser 를 통과하므로 속성·본문 모두 이스케이프가 필요하다.
function renderWikiLink(tokens: { content: string }[], idx: number): string {
  const inner = tokens[idx].content;
  return `<span data-wikilink data-inner="${escapeAttr(inner)}">[[${escapeText(inner)}]]</span>`;
}

// parse.setup 은 parse() 호출마다 실행된다(MarkdownParser.parse).
// ruler.before 를 같은 이름으로 두 번 등록하면 markdown-it 이 예외를 던지므로,
// 인스턴스별로 한 번만 설정한다.
const configured = new WeakSet<object>();

export function setupWikiLinkMarkdownIt(md: MarkdownIt): void {
  if (configured.has(md)) return;
  configured.add(md);
  md.inline.ruler.before("link", "wikilink", wikiLinkRule as never);
  (md.renderer.rules as Record<string, unknown>).wikilink = renderWikiLink;
}

export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      inner: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-inner") ?? "",
        renderHTML: (attributes) => ({ "data-inner": attributes.inner as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]" }];
  },

  // atom 노드는 기본적으로 textContent 가 빈 문자열이다. 그런데 tiptap-markdown 의
  // 표 직렬화는 `if (cellContent.textContent.trim())` 로 빈 셀을 판별해 건너뛰므로
  // (node_modules/tiptap-markdown/src/extensions/nodes/table.js:29),
  // 위키링크만 든 셀이 통째로 사라진다.
  //
  // textContent 는 ProseMirror NodeSpec 의 leafText 에서 나온다(tiptap 의
  // renderText 가 아니다 — 그건 editor.getText() 경로). 여기서 leafText 를 주면
  // 표 셀이 비어 보이지 않고, 복사·검색에도 링크 텍스트가 잡힌다.
  extendNodeSchema() {
    return {
      leafText: (node: { attrs: { inner: string } }) => `[[${node.attrs.inner}]]`,
    };
  },

  renderText({ node }) {
    return `[[${node.attrs.inner as string}]]`;
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-wikilink": "", class: "wikilink" }),
      `[[${node.attrs.inner as string}]]`,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerLike, node: { attrs: { inner: string } }) {
          // write() 는 esc() 를 거치지 않는다 — `[[` 가 이스케이프되지 않는 핵심.
          // 전역 esc() 는 그대로 두므로 위험 스킴 차단 등 기존 동작은 영향 없다.
          state.write(`[[${node.attrs.inner}]]`);
        },
        parse: {
          setup(markdownit: MarkdownIt) {
            setupWikiLinkMarkdownIt(markdownit);
          },
        },
      },
    };
  },
});

// tiptap-markdown / markdown-it 의 내부 타입은 공개되지 않아 최소 형태만 선언한다.
type MarkdownSerializerLike = { write(text: string): void };
type MarkdownItInlineState = {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): { content: string; markup: string };
};
