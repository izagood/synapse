import { describe, expect, it } from "vitest";
import { highlightSnippet } from "./searchHighlight";

describe("highlightSnippet", () => {
  it("splits around a single match", () => {
    expect(highlightSnippet("foo needle bar", "needle")).toEqual([
      { text: "foo ", match: false },
      { text: "needle", match: true },
      { text: " bar", match: false },
    ]);
  });

  it("matches case-insensitively but preserves original casing", () => {
    expect(highlightSnippet("A NeEdLe here", "needle")).toEqual([
      { text: "A ", match: false },
      { text: "NeEdLe", match: true },
      { text: " here", match: false },
    ]);
  });

  it("highlights multiple occurrences", () => {
    expect(highlightSnippet("ab ab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: " ", match: false },
      { text: "ab", match: true },
    ]);
  });

  it("handles a match at the very start and end", () => {
    expect(highlightSnippet("needle", "needle")).toEqual([
      { text: "needle", match: true },
    ]);
  });

  it("returns the whole text unmatched when there is no match", () => {
    expect(highlightSnippet("nothing here", "xyz")).toEqual([
      { text: "nothing here", match: false },
    ]);
  });

  it("returns the whole text unmatched for an empty query", () => {
    expect(highlightSnippet("anything", "  ")).toEqual([
      { text: "anything", match: false },
    ]);
  });
});
