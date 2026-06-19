import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
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

/**
 * 임의의 DOM 노드(텍스트/엘리먼트)에서 그것을 품은 .tiptap 직속 블록을 찾는다.
 * 현재 줄(커서 위치) 강조에 쓰며, .tiptap 밖이면 null.
 */
export function blockAncestor(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null =
    node && node.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : (node as HTMLElement | null);
  while (el && el.parentElement && !el.parentElement.classList.contains("tiptap")) {
    el = el.parentElement;
  }
  return el && el.parentElement?.classList.contains("tiptap") ? el : null;
}

/** 현재 선택(커서)이 놓인 최상위 블록의 DOM 엘리먼트를 구한다. */
function activeBlockDOM(view: EditorView): HTMLElement | null {
  const { from } = view.state.selection;
  const { node } = view.domAtPos(from);
  return blockAncestor(node);
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
    el.contentEditable = "false";
    el.setAttribute("aria-hidden", "true");
    // 바깥 span은 블록 줄 높이만큼 늘어나 숫자를 세로 가운데로 정렬하고,
    // 안쪽 span이 실제 숫자를 항상 같은 크기(rem)로 그린다.
    const digit = document.createElement("span");
    digit.className = "ln-num__d";
    digit.textContent = String(line);
    el.appendChild(digit);
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
        // 현재 줄(커서 위치) 강조: 데코레이션 대신 활성 블록 DOM에 클래스를 토글한다.
        // (선택만 바뀌어도 번호 위젯을 다시 만들지 않도록 분리)
        view(editorView) {
          let current: HTMLElement | null = null;
          const sync = (v: EditorView) => {
            const next = activeBlockDOM(v);
            if (next === current) return;
            current?.classList.remove("ln-active");
            next?.classList.add("ln-active");
            current = next;
          };
          sync(editorView);
          return {
            update: (v) => sync(v),
            destroy: () => current?.classList.remove("ln-active"),
          };
        },
      }),
    ];
  },
});
