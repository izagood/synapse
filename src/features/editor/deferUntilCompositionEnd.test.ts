import { describe, expect, it, vi } from "vitest";
import { deferUntilCompositionEnd } from "./deferUntilCompositionEnd";

describe("deferUntilCompositionEnd", () => {
  it("조합 중이 아니면 즉시 apply하고 cleanup을 반환하지 않는다", () => {
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(target, false, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(cleanup).toBeUndefined();
  });

  it("조합 중이면 apply를 미루고 compositionend 후 1회 실행한다", () => {
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(target, true, apply);
    expect(apply).not.toHaveBeenCalled();
    expect(typeof cleanup).toBe("function");

    target.dispatchEvent(new Event("compositionend"));
    expect(apply).toHaveBeenCalledTimes(1);

    // 리스너가 제거되어 두 번째 compositionend엔 다시 실행되지 않는다
    target.dispatchEvent(new Event("compositionend"));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("cleanup을 호출하면 대기 중 apply가 실행되지 않는다", () => {
    const target = new EventTarget();
    const apply = vi.fn();
    const cleanup = deferUntilCompositionEnd(target, true, apply) as () => void;
    cleanup();
    target.dispatchEvent(new Event("compositionend"));
    expect(apply).not.toHaveBeenCalled();
  });
});
