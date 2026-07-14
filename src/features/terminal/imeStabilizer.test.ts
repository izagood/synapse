// @vitest-environment jsdom
// WebKit IME 안정화 레이어 단위 테스트.
//
// 실제 한글 IME 조합은 브라우저 자동화로 재현할 수 없으므로(jsdom엔 IME가 없다)
// 조합 이벤트를 합성해 "조합 중 xterm의 간섭을 차단한다"는 계약만 검증한다.
// 실기기 검증 체크리스트는 specs/2026-07-14-embedded-terminal-ime-design.md §5.

import { describe, expect, it, vi } from "vitest";
import {
  attachImeStabilizer,
  isWebKitEngine,
  shouldBypassXtermKey,
  type ImeStabilizerTarget,
} from "./imeStabilizer";

const WEBKIT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function makeTarget(): { term: ImeStabilizerTarget; textarea: HTMLTextAreaElement } {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  const term: ImeStabilizerTarget = {
    textarea,
    attachCustomKeyEventHandler: vi.fn(),
  };
  return { term, textarea };
}

function fireComposition(el: HTMLTextAreaElement, type: "compositionstart" | "compositionend") {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe("shouldBypassXtermKey", () => {
  it("조합 중(isComposing) 키는 xterm에서 제외한다", () => {
    expect(shouldBypassXtermKey({ isComposing: true, keyCode: 65 })).toBe(true);
  });

  it("WebKit이 조합 직전 보내는 keyCode 229도 제외한다", () => {
    expect(shouldBypassXtermKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("일반 키(Ctrl-C, 화살표 등)는 xterm이 그대로 처리한다", () => {
    expect(shouldBypassXtermKey({ isComposing: false, keyCode: 67 })).toBe(false);
    expect(shouldBypassXtermKey({ isComposing: false, keyCode: 37 })).toBe(false);
  });
});

describe("isWebKitEngine", () => {
  it("WKWebView(순수 AppleWebKit) UA를 감지한다", () => {
    expect(isWebKitEngine(WEBKIT_UA)).toBe(true);
  });

  it("Chromium 계열(Chrome/Edg)은 제외한다", () => {
    expect(isWebKitEngine(CHROME_UA)).toBe(false);
    expect(isWebKitEngine(CHROME_UA.replace("Chrome/126.0", "Edg/126.0"))).toBe(false);
  });
});

describe("attachImeStabilizer", () => {
  it("Chromium UA에서는 아무것도 하지 않는다", () => {
    const { term } = makeTarget();
    const detach = attachImeStabilizer(term, { userAgent: CHROME_UA });
    expect(term.attachCustomKeyEventHandler).not.toHaveBeenCalled();
    detach();
  });

  it("textarea가 없으면(no-op) 안전하게 해제 함수만 반환한다", () => {
    const term: ImeStabilizerTarget = {
      textarea: undefined,
      attachCustomKeyEventHandler: vi.fn(),
    };
    expect(() => attachImeStabilizer(term, { force: true })()).not.toThrow();
  });

  it("커스텀 키 핸들러를 등록해 조합 키를 xterm에서 제외한다", () => {
    const { term } = makeTarget();
    const detach = attachImeStabilizer(term, { userAgent: WEBKIT_UA });
    const handler = vi.mocked(term.attachCustomKeyEventHandler).mock.calls[0][0];
    // 핸들러 규약: false = xterm이 무시, true = xterm이 처리
    expect(handler({ isComposing: false, keyCode: 229 } as KeyboardEvent)).toBe(false);
    expect(handler({ isComposing: true, keyCode: 65 } as KeyboardEvent)).toBe(false);
    expect(handler({ isComposing: false, keyCode: 65 } as KeyboardEvent)).toBe(true);
    detach();
  });

  it("조합 중 value 리셋(빈 문자열 대입)을 무시한다 — 자모 분해의 직접 원인", () => {
    const { term, textarea } = makeTarget();
    const detach = attachImeStabilizer(term, { force: true });

    fireComposition(textarea, "compositionstart");
    textarea.value = "하";
    textarea.value = ""; // xterm의 입력 후 리셋 — 조합 중엔 무시돼야 한다
    expect(textarea.value).toBe("하");

    // 빈 문자열이 아닌 대입(조합 갱신)은 통과한다
    textarea.value = "한";
    expect(textarea.value).toBe("한");
    detach();
  });

  it("조합이 끝나면(한 틱 뒤) value 리셋이 다시 허용된다", async () => {
    const { term, textarea } = makeTarget();
    const detach = attachImeStabilizer(term, { force: true });

    fireComposition(textarea, "compositionstart");
    textarea.value = "한";
    fireComposition(textarea, "compositionend");
    // xterm의 compositionend 처리(setTimeout 0) 이후에 방어가 풀린다
    await new Promise((r) => setTimeout(r, 1));
    textarea.value = "";
    expect(textarea.value).toBe("");
    detach();
  });

  it("조합 중 textarea 위치 이동을 동기적으로 차단한다", () => {
    const { term, textarea } = makeTarget();
    textarea.style.left = "10px";
    const detach = attachImeStabilizer(term, { force: true });

    fireComposition(textarea, "compositionstart");
    textarea.style.left = "999px"; // xterm의 커서 추적 이동 — 무시돼야 한다
    textarea.style.setProperty("top", "50px");
    expect(textarea.style.left).toBe("10px");
    expect(textarea.style.top).toBe("");

    // 위치와 무관한 속성은 조합 중에도 통과한다
    textarea.style.opacity = "0.5";
    expect(textarea.style.opacity).toBe("0.5");
    detach();
  });

  it("조합 중이 아니면 위치 이동을 그대로 허용한다", () => {
    const { term, textarea } = makeTarget();
    const detach = attachImeStabilizer(term, { force: true });
    textarea.style.left = "42px";
    expect(textarea.style.left).toBe("42px");
    detach();
  });

  it("해제하면 원본 동작(value/style/키 핸들러)이 복원된다", () => {
    const { term, textarea } = makeTarget();
    const detach = attachImeStabilizer(term, { force: true });
    fireComposition(textarea, "compositionstart");
    detach();

    // 해제 후에는 조합 플래그와 무관하게 원본 동작
    textarea.value = "한";
    textarea.value = "";
    expect(textarea.value).toBe("");
    textarea.style.left = "77px";
    expect(textarea.style.left).toBe("77px");
    // 키 핸들러는 모두 허용으로 되돌린다 (마지막 호출 확인)
    const calls = vi.mocked(term.attachCustomKeyEventHandler).mock.calls;
    const lastHandler = calls[calls.length - 1][0];
    expect(lastHandler({ isComposing: true, keyCode: 229 } as KeyboardEvent)).toBe(true);
  });
});
