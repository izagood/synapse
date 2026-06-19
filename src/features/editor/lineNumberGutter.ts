import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// WYSIWYG 줄 번호 거터.
// 소스 텍스트의 "줄" 개념이 없으므로 최상위 블록 하나를 한 줄로 본다.
// 각 블록에 번호 위젯(span.ln-num)을 절대배치로 달아:
//  - 번호는 블록 폰트 크기와 무관하게 항상 같은 크기로(rem) 좌측 거터에 고정되고
//  - 블록이 커지면(예: 제목) 블록 높이만큼 번호 사이 간격이 자연히 벌어지며
//  - 번호에 마우스를 올리면 해당 블록을 하이라이트한다.
// 데코레이션은 직렬화에 전혀 관여하지 않으므로 라운드트립에 안전하다.

export const lineNumberGutterKey = new PluginKey("synapseLineNumbers");

export interface LineBlock {
  /** 1-기반 줄 번호 */
  line: number;
  /** 위젯을 놓을 문서 위치 */
  pos: number;
  /** 콘텐츠를 가질 수 없는 리프 블록인지(예: 수평선) */
  leaf: boolean;
}

/**
 * 최상위 블록마다 줄 번호 위젯의 위치를 계산한다.
 * 콘텐츠 블록은 내부 시작(offset+1)에 — 첫 줄에 번호가 정렬되도록 —,
 * 리프 블록은 바로 앞(offset)에 위젯을 놓는다.
 */
export function lineBlocks(doc: ProseMirrorNode): LineBlock[] {
  const blocks: LineBlock[] = [];
  let line = 0;
  doc.forEach((node, offset) => {
    line += 1;
    const leaf = node.isLeaf;
    blocks.push({ line, pos: leaf ? offset : offset + 1, leaf });
  });
  return blocks;
}

/**
 * 번호 위젯(span)에서 그것이 가리키는 최상위 블록 엘리먼트를 찾는다.
 *  - 콘텐츠 블록 내부에 박힌 위젯: .tiptap 직속 조상이 곧 그 블록.
 *  - 리프 블록 앞에 놓인 위젯(.tiptap 직속 자식): 다음 형제가 그 블록.
 */
export function resolveLineBlock(span: HTMLElement): HTMLElement | null {
  let node: HTMLElement = span;
  while (node.parentElement && !node.parentElement.classList.contains("tiptap")) {
    node = node.parentElement;
  }
  if (!node.parentElement) return null; // .tiptap 밖
  if (node === span) {
    const next = span.nextElementSibling;
    return next instanceof HTMLElement ? next : null;
  }
  return node;
}

function clearHighlight(span: HTMLElement): void {
  span
    .closest(".tiptap")
    ?.querySelectorAll(".ln-hover")
    .forEach((n) => n.classList.remove("ln-hover"));
}

function lineNumberWidget(line: number) {
  return () => {
    const el = document.createElement("span");
    el.className = "ln-num";
    el.textContent = String(line);
    el.contentEditable = "false";
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("mouseenter", () => {
      resolveLineBlock(el)?.classList.add("ln-hover");
    });
    // 떠날 때는 자기 블록만이 아니라 남아 있을 수 있는 모든 하이라이트를 정리한다
    // (재렌더로 enter 때와 다른 엘리먼트가 될 수 있어 안전하게 전부 제거).
    el.addEventListener("mouseleave", () => clearHighlight(el));
    return el;
  };
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decos = lineBlocks(doc).map(({ line, pos, leaf }) =>
    Decoration.widget(pos, lineNumberWidget(line), {
      side: -1,
      ignoreSelection: true,
      key: `ln:${line}:${leaf ? "l" : "i"}`,
    }),
  );
  return DecorationSet.create(doc, decos);
}

export const LineNumberGutter = Extension.create({
  name: "lineNumberGutter",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: lineNumberGutterKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return lineNumberGutterKey.getState(state);
          },
        },
      }),
    ];
  },
});
