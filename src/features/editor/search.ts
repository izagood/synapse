import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";

// 문서 내 찾기 (Cmd/Ctrl+F) — ProseMirror 데코레이션으로 매치를 하이라이트한다.
// 마크다운 직렬화에는 전혀 관여하지 않으므로 라운드트립에 안전하다.

export interface SearchMatch {
  from: number;
  to: number;
}

export interface TextSegment {
  text: string;
  pos: number; // 이 텍스트의 첫 글자가 놓인 문서 위치
}

interface SearchState {
  term: string;
  caseSensitive: boolean;
  matches: SearchMatch[];
  current: number; // matches 인덱스, 매치 없으면 -1
}

type SearchMeta =
  | { type: "set"; term: string; caseSensitive: boolean; anchor: number }
  | { type: "current"; index: number }
  | { type: "clear" };

export const searchPluginKey = new PluginKey<SearchState>("synapseSearch");

/**
 * 텍스트 세그먼트들에서 term의 모든 출현 위치를 문서 좌표로 반환한다.
 * 세그먼트는 문서 순서대로 주어진다고 가정한다 (doc.descendants 순회 순서).
 * 매치는 한 텍스트 노드 안에서만 찾는다 (블록 경계를 넘는 매치는 없음).
 */
export function searchInSegments(
  segments: TextSegment[],
  term: string,
  opts: { caseSensitive?: boolean } = {},
): SearchMatch[] {
  if (!term) return [];
  const caseSensitive = opts.caseSensitive ?? false;
  const needle = caseSensitive ? term : term.toLowerCase();
  const matches: SearchMatch[] = [];
  for (const seg of segments) {
    const hay = caseSensitive ? seg.text : seg.text.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      matches.push({ from: seg.pos + idx, to: seg.pos + idx + term.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
  }
  return matches;
}

function collectSegments(doc: ProseMirrorNode): TextSegment[] {
  const segments: TextSegment[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) segments.push({ text: node.text, pos });
  });
  return segments;
}

function computeMatches(
  doc: ProseMirrorNode,
  term: string,
  caseSensitive: boolean,
): SearchMatch[] {
  return searchInSegments(collectSegments(doc), term, { caseSensitive });
}

/** anchor 위치(보통 커서) 이후의 첫 매치를 고른다. 없으면 처음으로 되돌린다. */
function pickCurrent(matches: SearchMatch[], anchor: number): number {
  if (matches.length === 0) return -1;
  const at = matches.findIndex((m) => m.from >= anchor);
  return at === -1 ? 0 : at;
}

const empty: SearchState = {
  term: "",
  caseSensitive: false,
  matches: [],
  current: -1,
};

export const SearchHighlight = Extension.create({
  name: "searchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchPluginKey,
        state: {
          init: () => empty,
          apply(tr, value, _oldState, newState): SearchState {
            const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;
            if (meta) {
              if (meta.type === "clear") {
                return { ...empty, caseSensitive: value.caseSensitive };
              }
              if (meta.type === "current") {
                return { ...value, current: meta.index };
              }
              // type === "set"
              const matches = computeMatches(newState.doc, meta.term, meta.caseSensitive);
              return {
                term: meta.term,
                caseSensitive: meta.caseSensitive,
                matches,
                current: pickCurrent(matches, meta.anchor),
              };
            }
            // 편집으로 문서가 바뀌면 매치를 다시 계산하고 current를 범위 안으로 보정
            if (tr.docChanged && value.term) {
              const matches = computeMatches(newState.doc, value.term, value.caseSensitive);
              const current =
                matches.length === 0 ? -1 : Math.min(value.current, matches.length - 1);
              return { ...value, matches, current: current < 0 ? -1 : current };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const s = searchPluginKey.getState(state);
            if (!s || s.matches.length === 0) return DecorationSet.empty;
            const decos = s.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class:
                  i === s.current ? "find-match find-match-current" : "find-match",
              }),
            );
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export interface SearchInfo {
  /** 전체 매치 개수 */
  total: number;
  /** 현재 매치의 1-기반 순번, 매치 없으면 0 */
  current: number;
}

export function getSearchInfo(editor: Editor): SearchInfo {
  const s = searchPluginKey.getState(editor.state);
  if (!s || s.matches.length === 0) return { total: 0, current: 0 };
  return { total: s.matches.length, current: s.current + 1 };
}

/** 검색어를 설정하고 커서 이후 첫 매치로 스크롤한다. */
export function setSearchTerm(
  editor: Editor,
  term: string,
  caseSensitive: boolean,
): void {
  const anchor = editor.state.selection.from;
  editor.view.dispatch(
    editor.state.tr.setMeta(searchPluginKey, {
      type: "set",
      term,
      caseSensitive,
      anchor,
    } satisfies SearchMeta),
  );
  revealCurrent(editor);
}

/** 다음(dir=1)/이전(dir=-1) 매치로 이동한다 (양끝에서 순환). */
export function stepMatch(editor: Editor, dir: 1 | -1): void {
  const s = searchPluginKey.getState(editor.state);
  if (!s || s.matches.length === 0) return;
  const n = s.matches.length;
  const next = s.current < 0 ? (dir === 1 ? 0 : n - 1) : (s.current + dir + n) % n;
  editor.view.dispatch(
    editor.state.tr.setMeta(searchPluginKey, {
      type: "current",
      index: next,
    } satisfies SearchMeta),
  );
  revealCurrent(editor);
}

/** 검색 상태를 비우고 하이라이트를 제거한다. */
export function clearSearch(editor: Editor): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(searchPluginKey, { type: "clear" } satisfies SearchMeta),
  );
}

/** 현재 매치를 선택해 화면에 보이도록 스크롤한다. */
function revealCurrent(editor: Editor): void {
  const s = searchPluginKey.getState(editor.state);
  if (!s || s.current < 0) return;
  const m = s.matches[s.current];
  const tr = editor.state.tr;
  tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
  editor.view.dispatch(tr);
}
