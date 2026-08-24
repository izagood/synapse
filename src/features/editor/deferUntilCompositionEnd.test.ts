import { afterEach, describe, expect, it, vi } from "vitest";

import { deferUntilCompositionEnd } from "./deferUntilCompositionEnd";

afterEach(() => {
  vi.useRealTimers();
});

describe("deferUntilCompositionEnd", () => {
  it("조합 중이 아니면 즉시 apply하고 cleanup을 반환하지 않는다", () => {
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(target, false, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(cleanup).toBeUndefined();
  });

  it("조합 중이면 apply를 미루고, compositionend 후에도 한 틱 더 미뤘다 1회 실행한다", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const apply = vi.fn();
    deferUntilCompositionEnd(target, true, apply);
    expect(apply).not.toHaveBeenCalled();

    // compositionend 시점엔 아직 적용하지 않는다 (PM 정리 대기)
    target.dispatchEvent(new Event("compositionend"));
    expect(apply).not.toHaveBeenCalled();

    // 다음 매크로태스크에서 1회 적용
    vi.runAllTimers();
    expect(apply).toHaveBeenCalledTimes(1);

    // 리스너가 제거되어 두 번째 compositionend엔 다시 예약되지 않는다
    target.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("compositionend 전에 cleanup하면 적용이 예약되지 않는다", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(target, true, apply) as () => void;
    cleanup();
    target.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers();
    expect(apply).not.toHaveBeenCalled();
  });

  it("compositionend 후 타이머 발화 전에 cleanup하면 적용을 취소한다", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(target, true, apply) as () => void;
    target.dispatchEvent(new Event("compositionend"));
    cleanup();
    vi.runAllTimers();
    expect(apply).not.toHaveBeenCalled();
  });

  it("한 틱 사이 새 조합이 시작되면 다음 compositionend까지 재연기한다", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const apply = vi.fn();
    let composing = true;
    const getIsComposing = vi.fn(() => composing);

    deferUntilCompositionEnd(target, true, apply, getIsComposing);

    // 1차 조합 종료 — 그 한 틱 사이에 이미 새 조합이 시작된 상태(한글 연타).
    // 시간이 아무리 지나도(runAllTimers) 조합 중 적용은 절대 없다.
    target.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers();
    expect(apply).not.toHaveBeenCalled();

    // 2차 조합 종료 — 이제 조합 밖이므로 한 틱 뒤 1회 적용된다
    composing = false;
    target.dispatchEvent(new Event("compositionend"));
    expect(apply).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("재연기 중에도 cleanup이 대기를 취소한다", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(
      target,
      true,
      apply,
      () => true, // 항상 조합 중 → 재연기 경로 진입
    ) as () => void;

    target.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers(); // 재연기: 리스너 재등록 상태
    cleanup();
    target.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers();
    expect(apply).not.toHaveBeenCalled();
  });

  it("getIsComposing 없이도 동작한다 (하위 호환성)", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const apply = vi.fn();
    deferUntilCompositionEnd(target, true, apply);

    target.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
