import { describe, expect, it } from "vitest";
import { syncCommitMessage } from "./commitMessage";

describe("syncCommitMessage", () => {
  it("includes local date and time down to seconds", () => {
    const fixed = new Date(2026, 5, 10, 21, 30, 45); // 2026-06-10 21:30:45 (로컬)
    expect(syncCommitMessage(fixed)).toBe("synapse: 노트 동기화 2026-06-10 21:30:45");
  });

  it("zero-pads single digit fields", () => {
    const fixed = new Date(2026, 0, 5, 9, 3, 7);
    expect(syncCommitMessage(fixed)).toBe("synapse: 노트 동기화 2026-01-05 09:03:07");
  });

  it("matches the expected pattern for the current time", () => {
    expect(syncCommitMessage()).toMatch(
      /^synapse: 노트 동기화 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });
});
