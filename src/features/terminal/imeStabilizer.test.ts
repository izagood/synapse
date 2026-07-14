// @vitest-environment jsdom
// WebKit IME 어댑터 단위 테스트.
//
// 실기기 계측(2026-07-14, macOS WKWebView + 한글 2벌식)으로 확보한 실제 이벤트
// 시퀀스를 합성해 검증한다: 한글 IM은 composition 이벤트 없이
// insertText("ㅎ") → insertReplacementText("하"→"한") → insertText("ㄱ") 치환
// 흐름으로 동작하며, 음절 확정 신호는 다음 insertText/일반 keydown/blur다.
// 실기기 검증 체크리스트는 specs/2026-07-14-embedded-terminal-ime-design.md §5.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachImeStabilizer,
  isImeText,
  isWebKitEngine,
  shouldBypassXtermKey,
  type ImeStabilizerTarget,
} from "./imeStabilizer";

const WEBKIT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  document.body.innerHTML = "";
});

function makeTarget(): {
  term: ImeStabilizerTarget;
  textarea: HTMLTextAreaElement;
  sent: string[];
} {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  const sent: string[] = [];
  const term: ImeStabilizerTarget = {
    textarea,
    attachCustomKeyEventHandler: vi.fn(),
    input: (d: string) => sent.push(d),
  };
  return { term, textarea, sent };
}

function attach(term: ImeStabilizerTarget): () => void {
  const detach = attachImeStabilizer(term, { force: true });
  cleanups.push(detach);
  return detach;
}

/** jsdom의 InputEvent가 inputType을 지원하지 않아도 동작하도록 속성을 직접 정의한다. */
function fireInput(
  el: HTMLTextAreaElement,
  type: "beforeinput" | "input",
  inputType: string,
  data: string | null,
  isComposing = false,
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "inputType", { value: inputType });
  Object.defineProperty(e, "data", { value: data });
  Object.defineProperty(e, "isComposing", { value: isComposing });
  el.dispatchEvent(e);
}

function fireKeydown(el: HTMLTextAreaElement, keyCode: number, isComposing = false) {
  const e = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "keyCode", { value: keyCode });
  Object.defineProperty(e, "isComposing", { value: isComposing });
  el.dispatchEvent(e);
}

function fireComposition(el: HTMLTextAreaElement, type: "compositionstart" | "compositionend") {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe("shouldBypassXtermKey", () => {
  it("조합 중(isComposing)·keyCode 229 키는 xterm에서 제외한다", () => {
    expect(shouldBypassXtermKey({ isComposing: true, keyCode: 65 })).toBe(true);
    expect(shouldBypassXtermKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("일반 키(Ctrl-C, 화살표 등)는 xterm이 그대로 처리한다", () => {
    expect(shouldBypassXtermKey({ isComposing: false, keyCode: 67 })).toBe(false);
    expect(shouldBypassXtermKey({ isComposing: false, keyCode: 37 })).toBe(false);
  });
});

describe("isWebKitEngine / isImeText", () => {
  it("WKWebView(순수 AppleWebKit) UA만 감지한다", () => {
    expect(isWebKitEngine(WEBKIT_UA)).toBe(true);
    expect(isWebKitEngine(CHROME_UA)).toBe(false);
    expect(isWebKitEngine(CHROME_UA.replace("Chrome/126.0", "Edg/126.0"))).toBe(false);
  });

  it("비ASCII(자모·한글·이모지)만 IME 텍스트로 본다", () => {
    expect(isImeText("ㅎ")).toBe(true);
    expect(isImeText("한")).toBe(true);
    expect(isImeText("a")).toBe(false);
    expect(isImeText(" ")).toBe(false);
  });
});

describe("attachImeStabilizer — insertText 어댑터 (실기기 계측 시퀀스)", () => {
  it("Chromium UA에서는 아무것도 하지 않는다", () => {
    const { term } = makeTarget();
    const detach = attachImeStabilizer(term, { userAgent: CHROME_UA });
    cleanups.push(detach);
    expect(term.attachCustomKeyEventHandler).not.toHaveBeenCalled();
  });

  it("textarea가 없으면 안전한 no-op 해제 함수를 반환한다", () => {
    const term: ImeStabilizerTarget = {
      textarea: undefined,
      attachCustomKeyEventHandler: vi.fn(),
      input: vi.fn(),
    };
    expect(() => attachImeStabilizer(term, { force: true })()).not.toThrow();
  });

  it("WebKit에서 textarea에 최소 가시성(opacity>0)을 부여한다 — IME 부착 조건", () => {
    const { term, textarea } = makeTarget();
    attach(term);
    expect(Number(textarea.style.opacity)).toBeGreaterThan(0);
  });

  it("'한글 ' 입력: 완성 음절만 순서대로 PTY에 흘려보낸다", () => {
    const { term, textarea, sent } = makeTarget();
    attach(term);

    // 실기기 로그 그대로: ㅎ→하→한 (치환) → ㄱ(새 음절, 한 확정) → 그→글 → 스페이스
    fireInput(textarea, "beforeinput", "insertText", "ㅎ");
    fireKeydown(textarea, 229);
    fireInput(textarea, "beforeinput", "insertReplacementText", "하");
    fireKeydown(textarea, 229);
    fireInput(textarea, "beforeinput", "insertReplacementText", "한");
    fireKeydown(textarea, 229);
    fireInput(textarea, "beforeinput", "insertReplacementText", "한"); // 중복 치환(관찰됨)
    fireInput(textarea, "beforeinput", "insertText", "ㄱ"); // ← "한" 확정
    expect(sent).toEqual(["한"]);

    fireKeydown(textarea, 229);
    fireInput(textarea, "beforeinput", "insertReplacementText", "그");
    fireKeydown(textarea, 229);
    fireInput(textarea, "beforeinput", "insertReplacementText", "글");
    fireKeydown(textarea, 32); // 스페이스 — xterm이 " "를 보내기 전에 "글"이 먼저 흘러야 한다
    expect(sent).toEqual(["한", "글"]);
  });

  it("Enter 등 일반 keydown이 pending 음절을 먼저 확정한다", () => {
    const { term, textarea, sent } = makeTarget();
    attach(term);
    fireInput(textarea, "beforeinput", "insertText", "ㅎ");
    fireInput(textarea, "beforeinput", "insertReplacementText", "한");
    fireKeydown(textarea, 13); // Enter
    expect(sent).toEqual(["한"]);
  });

  it("blur가 pending 음절을 확정한다", () => {
    const { term, textarea, sent } = makeTarget();
    attach(term);
    fireInput(textarea, "beforeinput", "insertText", "ㅎ");
    textarea.dispatchEvent(new Event("blur"));
    expect(sent).toEqual(["ㅎ"]);
  });

  it("비ASCII insertText/치환은 xterm으로 전파되지 않는다 (자모 유출 차단)", () => {
    const { term, textarea } = makeTarget();
    attach(term);
    const leaked: string[] = [];
    const spy = (e: Event) => leaked.push((e as InputEvent).inputType);
    document.addEventListener("beforeinput", spy); // 버블 단계 = xterm 리스너 위치의 근사
    cleanups.push(() => document.removeEventListener("beforeinput", spy));

    fireInput(textarea, "beforeinput", "insertText", "ㅎ");
    fireInput(textarea, "beforeinput", "insertReplacementText", "하");
    expect(leaked).toEqual([]);

    // ASCII insertText는 기존 경로 그대로 (keydown이 이미 처리하므로 간섭 금지)
    fireInput(textarea, "beforeinput", "insertText", "a");
    expect(leaked).toEqual(["insertText"]);
  });

  it("ASCII 입력은 어댑터가 PTY로 보내지 않는다 (keydown 경로가 담당)", () => {
    const { term, textarea, sent } = makeTarget();
    attach(term);
    fireKeydown(textarea, 65);
    fireInput(textarea, "beforeinput", "insertText", "a");
    expect(sent).toEqual([]);
  });

  it("isComposing 이벤트(DOM composition IME)는 어댑터가 건드리지 않는다", () => {
    const { term, textarea, sent } = makeTarget();
    attach(term);
    fireInput(textarea, "beforeinput", "insertText", "あ", true);
    fireKeydown(textarea, 13, true);
    expect(sent).toEqual([]);
  });

  it("해제 시 pending을 확정하고 이후 이벤트를 무시한다", () => {
    const { term, textarea, sent } = makeTarget();
    const detach = attach(term);
    fireInput(textarea, "beforeinput", "insertText", "ㅎ");
    detach();
    expect(sent).toEqual(["ㅎ"]);
    fireInput(textarea, "beforeinput", "insertText", "ㄴ");
    fireKeydown(textarea, 13);
    expect(sent).toEqual(["ㅎ"]);
  });
});

describe("attachImeStabilizer — DOM composition 경로 방어 (기존 유지)", () => {
  it("조합 중 value 리셋(빈 문자열 대입)을 무시한다", () => {
    const { term, textarea } = makeTarget();
    attach(term);
    fireComposition(textarea, "compositionstart");
    textarea.value = "하";
    textarea.value = "";
    expect(textarea.value).toBe("하");
    textarea.value = "한";
    expect(textarea.value).toBe("한");
  });

  it("조합이 끝나면(한 틱 뒤) value 리셋이 다시 허용된다", async () => {
    const { term, textarea } = makeTarget();
    attach(term);
    fireComposition(textarea, "compositionstart");
    textarea.value = "한";
    fireComposition(textarea, "compositionend");
    await new Promise((r) => setTimeout(r, 1));
    textarea.value = "";
    expect(textarea.value).toBe("");
  });

  it("조합 중 textarea 위치 이동을 동기적으로 차단한다", () => {
    const { term, textarea } = makeTarget();
    attach(term);
    textarea.style.left = "10px";
    fireComposition(textarea, "compositionstart");
    textarea.style.left = "999px";
    textarea.style.setProperty("top", "50px");
    expect(textarea.style.left).toBe("10px");
    expect(textarea.style.top).toBe("");
    // 위치와 무관한 속성은 조합 중에도 통과 (opacity는 부착 시 0.05로 설정됨)
    textarea.style.opacity = "0.5";
    expect(textarea.style.opacity).toBe("0.5");
  });

  it("해제하면 원본 동작(value/style/키 핸들러)이 복원된다", () => {
    const { term, textarea } = makeTarget();
    const detach = attach(term);
    fireComposition(textarea, "compositionstart");
    detach();
    textarea.value = "한";
    textarea.value = "";
    expect(textarea.value).toBe("");
    textarea.style.left = "77px";
    expect(textarea.style.left).toBe("77px");
    const calls = vi.mocked(term.attachCustomKeyEventHandler).mock.calls;
    const lastHandler = calls[calls.length - 1][0];
    expect(lastHandler({ isComposing: true, keyCode: 229 } as KeyboardEvent)).toBe(true);
  });
});
