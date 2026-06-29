import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReloadScheduler, isLocalRoot } from "./fileWatch";

describe("createReloadScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("한 번에 몰린 trigger를 단 한 번의 reload로 합친다", () => {
    const reload = vi.fn();
    const s = createReloadScheduler(reload, 400);
    s.trigger();
    s.trigger();
    s.trigger();
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("새 trigger가 조용한 구간을 리셋한다 (trailing debounce)", () => {
    const reload = vi.fn();
    const s = createReloadScheduler(reload, 400);
    s.trigger();
    vi.advanceTimersByTime(300);
    s.trigger(); // 타이머 리셋
    vi.advanceTimersByTime(300);
    expect(reload).not.toHaveBeenCalled(); // 마지막 trigger로부터 300ms뿐
    vi.advanceTimersByTime(100);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("한 번 실행한 뒤 다음 폭주에 다시 실행된다", () => {
    const reload = vi.fn();
    const s = createReloadScheduler(reload, 100);
    s.trigger();
    vi.advanceTimersByTime(100);
    expect(reload).toHaveBeenCalledTimes(1);
    s.trigger();
    vi.advanceTimersByTime(100);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("cancel은 대기 중인 reload를 막는다", () => {
    const reload = vi.fn();
    const s = createReloadScheduler(reload, 100);
    s.trigger();
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("isLocalRoot", () => {
  it("일반 경로는 로컬로 본다", () => {
    expect(isLocalRoot("/home/me/notes")).toBe(true);
    expect(isLocalRoot("C:\\notes")).toBe(true);
  });
  it("ssh:// 루트는 원격으로 본다", () => {
    expect(isLocalRoot("ssh://me@host/notes")).toBe(false);
  });
});
