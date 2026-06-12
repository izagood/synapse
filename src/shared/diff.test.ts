import { describe, expect, it } from "vitest";
import { diffLines, splitLines } from "./diff";

describe("splitLines", () => {
  it("empty string is zero lines", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("ignores a single trailing newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps a trailing blank line when there are two newlines", () => {
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });

  it("normalizes CRLF and CR", () => {
    expect(splitLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
  });
});

describe("diffLines", () => {
  it("identical text has no changes and only equal rows", () => {
    const { rows, added, removed } = diffLines("a\nb\nc", "a\nb\nc");
    expect(added).toBe(0);
    expect(removed).toBe(0);
    expect(rows.every((r) => r.op === "equal")).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => [r.leftNo, r.rightNo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("classifies a pure addition", () => {
    const { rows, added, removed } = diffLines("a\nc", "a\nb\nc");
    expect(added).toBe(1);
    expect(removed).toBe(0);
    const addRow = rows.find((r) => r.op === "add");
    expect(addRow).toMatchObject({ op: "add", leftNo: null, rightNo: 2, text: "b" });
  });

  it("classifies a pure deletion", () => {
    const { rows, added, removed } = diffLines("a\nb\nc", "a\nc");
    expect(added).toBe(0);
    expect(removed).toBe(1);
    const removeRow = rows.find((r) => r.op === "remove");
    expect(removeRow).toMatchObject({
      op: "remove",
      leftNo: 2,
      rightNo: null,
      text: "b",
    });
  });

  it("represents a modified line as remove + add", () => {
    const { rows, added, removed } = diffLines("a\nOLD\nc", "a\nNEW\nc");
    expect(added).toBe(1);
    expect(removed).toBe(1);
    const ops = rows.map((r) => r.op);
    // 변경 줄: remove(OLD)와 add(NEW)가 모두 등장한다
    expect(ops).toContain("remove");
    expect(ops).toContain("add");
    expect(rows.find((r) => r.op === "remove")?.text).toBe("OLD");
    expect(rows.find((r) => r.op === "add")?.text).toBe("NEW");
    // 양쪽에 공통인 a, c는 equal로 남는다
    expect(rows.filter((r) => r.op === "equal").map((r) => r.text)).toEqual([
      "a",
      "c",
    ]);
  });

  it("left empty -> everything added", () => {
    const { rows, added, removed } = diffLines("", "x\ny");
    expect(removed).toBe(0);
    expect(added).toBe(2);
    expect(rows.map((r) => r.op)).toEqual(["add", "add"]);
  });

  it("right empty -> everything removed", () => {
    const { added, removed } = diffLines("x\ny", "");
    expect(added).toBe(0);
    expect(removed).toBe(2);
  });

  it("line numbers stay consistent across mixed edits", () => {
    // mine:   1:keep 2:drop 3:same
    // theirs: 1:keep 2:same 3:new
    const { rows } = diffLines("keep\ndrop\nsame", "keep\nsame\nnew");
    const equal = rows.filter((r) => r.op === "equal");
    expect(equal.map((r) => r.text)).toEqual(["keep", "same"]);
    // "same"은 mine 3번째 줄, theirs 2번째 줄
    const sameRow = equal.find((r) => r.text === "same")!;
    expect(sameRow.leftNo).toBe(3);
    expect(sameRow.rightNo).toBe(2);
    // "new"는 theirs 3번째 줄로 추가
    expect(rows.find((r) => r.text === "new")).toMatchObject({
      op: "add",
      leftNo: null,
      rightNo: 3,
    });
  });
});
