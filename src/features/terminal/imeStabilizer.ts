// WebKit(WKWebView/WebKitGTK)에서 xterm.js IME 조합이 깨지는 문제의 우회 레이어.
//
// 원인: xterm은 키/IME 입력을 hidden textarea로 받는데, 커서 추적을 위해 이
// textarea를 매 입력마다 이동시키고 value를 초기화한다. Chromium은 그래도 조합
// 컨텍스트를 유지하지만 WebKit은 그때마다 조합을 리셋해 한글이 자모로 분해된다
// (xterm.js #5894, #5887, #1939 — Electron/Chrome 호스트는 정상, WKWebView만 깨짐).
//
// 전략: 조합 중(compositionstart~end)에만 xterm의 textarea 간섭을 동기적으로 차단한다.
//  1) value 리셋 차단 — 인스턴스 accessor로 프로토타입 setter를 감싸 빈 문자열 대입 무시
//  2) 위치 이동 차단 — style 접근자를 Proxy로 감싸 위치/크기 속성 쓰기 무시
//  3) keyCode 229 가드 — 조합이 만든 keydown을 xterm 키 파이프라인에서 제외
// 조합 텍스트는 xterm CompositionHelper의 compositionend 경로로만 PTY에 전달된다.
//
// xterm 코드는 수정하지 않으며, 실패 시 원본 동작으로 폴백한다(터미널 자체는 유지).

/** attachImeStabilizer가 필요로 하는 xterm Terminal의 최소 표면 (테스트 용이성). */
export interface ImeStabilizerTarget {
  textarea: HTMLTextAreaElement | undefined;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

/**
 * 조합 중 문자를 낱자로 커밋시키는 WebKit의 keydown(keyCode 229 또는 isComposing)을
 * xterm 키 파이프라인에서 제외할지 판정한다. 순수 함수 — 단위 테스트 대상.
 */
export function shouldBypassXtermKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Blink(Chromium)는 IME가 정상이므로 손대지 않고, WebKit 계열에서만 활성화한다.
 * WKWebView UA에는 AppleWebKit이 있고 Chrome/Chromium/Edg 마커가 없다.
 */
export function isWebKitEngine(userAgent: string): boolean {
  return /AppleWebKit/i.test(userAgent) && !/Chrome|Chromium|Edg\//i.test(userAgent);
}

/** 조합 중 이동을 막을 위치/크기 계열 스타일 속성 (camelCase·kebab-case 모두). */
const FROZEN_STYLE_PROPS = new Set([
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "transform",
  "cssText",
  "line-height",
  "lineHeight",
]);

interface StabilizerOptions {
  /** WebKit 감지를 건너뛰고 강제 활성화 (테스트용). */
  force?: boolean;
  /** UA 주입 (테스트용). 기본값은 navigator.userAgent. */
  userAgent?: string;
}

/**
 * xterm Terminal(term.open 이후)에 IME 안정화를 부착한다. 해제 함수를 반환한다.
 * WebKit이 아니거나 textarea가 없으면 no-op 해제 함수를 반환한다.
 */
export function attachImeStabilizer(
  term: ImeStabilizerTarget,
  options: StabilizerOptions = {},
): () => void {
  const ua = options.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (!options.force && !isWebKitEngine(ua)) return () => {};
  const textarea = term.textarea;
  if (!textarea) return () => {};

  let composing = false;

  // ---- (3) keyCode 229 가드 -------------------------------------------------
  // false 반환 시 xterm은 이벤트를 무시하고 브라우저 기본 동작(조합 진행)만 남는다.
  term.attachCustomKeyEventHandler((ev) => !shouldBypassXtermKey(ev));

  // ---- (1) 조합 중 value 리셋 차단 -------------------------------------------
  // 프로토타입 체인에서 value descriptor를 찾아 인스턴스 accessor로 감싼다.
  let valuePatched = false;
  try {
    const desc = findValueDescriptor(textarea);
    if (desc?.get && desc?.set) {
      const { get, set } = desc;
      Object.defineProperty(textarea, "value", {
        configurable: true,
        get() {
          return get.call(this);
        },
        set(v: string) {
          // xterm은 입력 처리 후 textarea.value = "" 로 리셋한다 — 조합 중엔 무시.
          if (composing && v === "") return;
          set.call(this, v);
        },
      });
      valuePatched = true;
    }
  } catch {
    // accessor 재정의가 막힌 환경이면 이 방어선만 포기한다.
  }

  // ---- (2) 조합 중 위치 이동 차단 --------------------------------------------
  // style 접근자를 Proxy로 감싼다. Observer 되돌리기는 비동기라 WebKit이 이미
  // 조합을 리셋한 뒤일 수 있으므로, 쓰기 자체를 동기적으로 무시해야 한다.
  let stylePatched = false;
  try {
    const realStyle = textarea.style;
    const styleProxy = new Proxy(realStyle, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v === "function") {
          return (...args: unknown[]) => {
            // setProperty("left", ...) 계열도 조합 중엔 무시.
            if (
              composing &&
              (prop === "setProperty" || prop === "removeProperty") &&
              typeof args[0] === "string" &&
              FROZEN_STYLE_PROPS.has(args[0])
            ) {
              return undefined;
            }
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return v;
      },
      set(target, prop, value) {
        if (composing && typeof prop === "string" && FROZEN_STYLE_PROPS.has(prop)) {
          return true; // 조합 중 위치/크기 변경은 조용히 무시
        }
        return Reflect.set(target, prop, value, target);
      },
    });
    Object.defineProperty(textarea, "style", {
      configurable: true,
      get: () => styleProxy,
    });
    stylePatched = true;
  } catch {
    // Proxy/defineProperty가 막힌 환경이면 이 방어선만 포기한다.
  }

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    // xterm의 compositionend 처리(setTimeout 0에서 최종 문자열 전송 후 리셋)가
    // 끝난 다음에 방어를 풀어야 한다. 리스너 등록 순서상 xterm이 먼저 받지만,
    // 실제 전송·리셋은 태스크 큐에서 일어나므로 한 틱 뒤에 해제한다.
    setTimeout(() => {
      composing = false;
    }, 0);
  };
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);

  return () => {
    composing = false;
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
    if (valuePatched) delete (textarea as { value?: unknown }).value;
    if (stylePatched) delete (textarea as { style?: unknown }).style;
    term.attachCustomKeyEventHandler(() => true);
  };
}

/** 프로토타입 체인을 따라 올라가며 value accessor descriptor를 찾는다. */
function findValueDescriptor(el: HTMLTextAreaElement): PropertyDescriptor | undefined {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    const d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d) return d;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}
