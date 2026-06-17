import { describe, expect, it } from "vitest";
import { countLines, activeLineIndex } from "./lineNumbers";

describe("countLines", () => {
  it("빈 문자열도 1줄", () => {
    expect(countLines("")).toBe(1);
  });

  it("개행 수 + 1", () => {
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\nc")).toBe(3);
  });

  it("끝 개행은 빈 마지막 줄을 만든다", () => {
    expect(countLines("a\n")).toBe(2);
    expect(countLines("a\nb\n")).toBe(3);
  });

  it("CRLF의 \\r은 줄 수에 영향 없다(\\n만 카운트)", () => {
    expect(countLines("a\r\nb")).toBe(2);
  });
});

describe("activeLineIndex", () => {
  it("첫 줄은 0", () => {
    expect(activeLineIndex("hello world", 0)).toBe(0);
    expect(activeLineIndex("hello world", 5)).toBe(0);
  });

  it("캐럿 앞의 개행 수가 줄 인덱스", () => {
    const text = "a\nbb\nccc";
    expect(activeLineIndex(text, 0)).toBe(0); // a 앞
    expect(activeLineIndex(text, 2)).toBe(1); // 첫 개행 직후 (bb)
    expect(activeLineIndex(text, 5)).toBe(2); // 둘째 개행 직후 (ccc)
  });

  it("개행 문자 위치는 아직 그 줄에 속한다", () => {
    // index 1 은 첫 '\n' 자리 — 그 앞(content[0])엔 개행이 없으므로 0줄
    expect(activeLineIndex("a\nb", 1)).toBe(0);
  });

  it("범위를 벗어난 캐럿은 보정한다", () => {
    const text = "a\nb\nc";
    expect(activeLineIndex(text, -5)).toBe(0);
    expect(activeLineIndex(text, 999)).toBe(2);
  });
});
