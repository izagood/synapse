// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./extensions";
import {
  clearSearch,
  getSearchInfo,
  searchInSegments,
  setSearchTerm,
  stepMatch,
} from "./search";

describe("searchInSegments (pure matching)", () => {
  it("finds all occurrences within a segment and maps to doc positions", () => {
    // "ababa" 의 'a' 는 0,2,4 위치, 세그먼트가 pos=1 에서 시작
    const matches = searchInSegments([{ text: "ababa", pos: 1 }], "a");
    expect(matches).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 6 },
    ]);
  });

  it("does not produce overlapping matches", () => {
    const matches = searchInSegments([{ text: "aaaa", pos: 0 }], "aa");
    expect(matches).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    const segs = [{ text: "Foo foo FOO", pos: 0 }];
    expect(searchInSegments(segs, "foo")).toHaveLength(3);
    expect(searchInSegments(segs, "foo", { caseSensitive: true })).toEqual([
      { from: 4, to: 7 },
    ]);
  });

  it("returns nothing for an empty term", () => {
    expect(searchInSegments([{ text: "hello", pos: 0 }], "")).toEqual([]);
  });

  it("keeps matches in document order across segments", () => {
    const matches = searchInSegments(
      [
        { text: "x cat", pos: 1 },
        { text: "cat y", pos: 10 },
      ],
      "cat",
    );
    expect(matches).toEqual([
      { from: 3, to: 6 },
      { from: 10, to: 13 },
    ]);
  });
});

function mountEditor(markdown: string): { editor: Editor; el: HTMLElement } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  return { editor, el };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("SearchHighlight extension (integration)", () => {
  it("decorates every match and tracks the current one", () => {
    const { editor, el } = mountEditor("alpha beta alpha gamma alpha");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    setSearchTerm(editor, "alpha", false);

    const all = el.querySelectorAll(".find-match");
    expect(all.length).toBe(3);
    expect(el.querySelectorAll(".find-match-current").length).toBe(1);
    expect(getSearchInfo(editor)).toEqual({ total: 3, current: 1 });
  });

  it("cycles through matches with wraparound", () => {
    const { editor, el } = mountEditor("one two one two one");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    setSearchTerm(editor, "one", false);
    expect(getSearchInfo(editor).current).toBe(1);

    stepMatch(editor, 1);
    expect(getSearchInfo(editor).current).toBe(2);

    stepMatch(editor, 1);
    expect(getSearchInfo(editor).current).toBe(3);

    // 마지막에서 다음 → 처음으로 순환
    stepMatch(editor, 1);
    expect(getSearchInfo(editor).current).toBe(1);

    // 처음에서 이전 → 마지막으로 순환
    stepMatch(editor, -1);
    expect(getSearchInfo(editor).current).toBe(3);
  });

  it("reports zero results for a missing term", () => {
    const { editor, el } = mountEditor("hello world");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    setSearchTerm(editor, "zzz", false);
    expect(getSearchInfo(editor)).toEqual({ total: 0, current: 0 });
    expect(el.querySelectorAll(".find-match").length).toBe(0);
  });

  it("clears highlights", () => {
    const { editor, el } = mountEditor("repeat repeat repeat");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    setSearchTerm(editor, "repeat", false);
    expect(el.querySelectorAll(".find-match").length).toBe(3);

    clearSearch(editor);
    expect(el.querySelectorAll(".find-match").length).toBe(0);
    expect(getSearchInfo(editor)).toEqual({ total: 0, current: 0 });
  });

  it("respects case sensitivity", () => {
    const { editor, el } = mountEditor("Cat cat CAT");
    cleanup = () => {
      editor.destroy();
      el.remove();
    };

    setSearchTerm(editor, "cat", true);
    expect(getSearchInfo(editor).total).toBe(1);

    setSearchTerm(editor, "cat", false);
    expect(getSearchInfo(editor).total).toBe(3);
  });
});
