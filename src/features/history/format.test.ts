import { describe, expect, it } from "vitest";
import { commitTitle, formatCommitTime } from "./format";

describe("formatCommitTime", () => {
  const now = new Date(2026, 5, 11, 18, 0, 0); // 2026-06-11 18:00 로컬

  it("shows time only for same-day commits", () => {
    const iso = new Date(2026, 5, 11, 10, 30, 0).toISOString();
    const out = formatCommitTime(iso, "ko", now);
    // 같은 날이면 날짜 없이 시:분만 (구분자/표기는 환경마다 다를 수 있어 길이로 검증)
    expect(out).not.toMatch(/2026/);
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it("includes the date for older commits", () => {
    const iso = new Date(2026, 5, 9, 9, 0, 0).toISOString();
    const out = formatCommitTime(iso, "ko", now);
    expect(out).toMatch(/2026/);
  });

  it("returns the raw string when unparseable", () => {
    expect(formatCommitTime("not-a-date", "ko", now)).toBe("not-a-date");
  });
});

describe("commitTitle", () => {
  it("returns the first line of a multi-line message", () => {
    expect(commitTitle("제목\n\n본문 설명", "abc1234")).toBe("제목");
  });

  it("falls back to the short hash for empty messages", () => {
    expect(commitTitle("   \n  ", "abc1234")).toBe("abc1234");
    expect(commitTitle("", "abc1234")).toBe("abc1234");
  });
});
