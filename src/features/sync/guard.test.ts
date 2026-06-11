import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoSyncDelayMs, shouldAutoSync, withTimeout } from "./guard";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("제한 시간 안에 끝나면 값을 그대로 돌려준다", async () => {
    const result = withTimeout(Promise.resolve(42), 1000, "동기화");
    await expect(result).resolves.toBe(42);
  });

  it("제한 시간 안의 거부는 원래 에러로 거부된다", async () => {
    const result = withTimeout(Promise.reject(new Error("원래 에러")), 1000, "동기화");
    await expect(result).rejects.toThrow("원래 에러");
  });

  it("제한 시간이 지나면 시간 초과 메시지로 거부된다", async () => {
    const never = new Promise<number>(() => undefined);
    const result = withTimeout(never, 30_000, "동기화");
    const assertion = expect(result).rejects.toMatch(/동기화 시간 초과 — 30초/);
    vi.advanceTimersByTime(30_000);
    await assertion;
  });

  it("성공 후에는 타이머가 발화해도 아무 일도 없다", async () => {
    const result = withTimeout(Promise.resolve("ok"), 1000, "동기화");
    await expect(result).resolves.toBe("ok");
    vi.advanceTimersByTime(5000); // 거부로 뒤집히지 않아야 한다
    await expect(result).resolves.toBe("ok");
  });
});

describe("autoSyncDelayMs", () => {
  it("실패가 없으면 기본 간격 그대로", () => {
    expect(autoSyncDelayMs(60_000, 0)).toBe(60_000);
  });

  it("연속 실패마다 2배로 늘어난다", () => {
    expect(autoSyncDelayMs(60_000, 1)).toBe(120_000);
    expect(autoSyncDelayMs(60_000, 2)).toBe(240_000);
    expect(autoSyncDelayMs(60_000, 3)).toBe(480_000);
  });

  it("8배에서 상한에 걸린다", () => {
    expect(autoSyncDelayMs(60_000, 3)).toBe(480_000);
    expect(autoSyncDelayMs(60_000, 4)).toBe(480_000);
    expect(autoSyncDelayMs(60_000, 100)).toBe(480_000);
  });
});

describe("shouldAutoSync", () => {
  const base = 60_000;

  it("첫 시도는 항상 허용", () => {
    expect(shouldAutoSync(1_000_000, null, base, 0)).toBe(true);
  });

  it("실패가 없으면 기본 간격이 지난 뒤 허용", () => {
    expect(shouldAutoSync(1_000_000 + base - 1, 1_000_000, base, 0)).toBe(false);
    expect(shouldAutoSync(1_000_000 + base, 1_000_000, base, 0)).toBe(true);
  });

  it("연속 실패 시 백오프 간격이 지나야 허용", () => {
    expect(shouldAutoSync(1_000_000 + base, 1_000_000, base, 2)).toBe(false);
    expect(shouldAutoSync(1_000_000 + 4 * base - 1, 1_000_000, base, 2)).toBe(false);
    expect(shouldAutoSync(1_000_000 + 4 * base, 1_000_000, base, 2)).toBe(true);
  });
});
