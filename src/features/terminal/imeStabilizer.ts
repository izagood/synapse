// WebKit(WKWebView/WebKitGTK)에서 xterm.js 한글(CJK) IME 입력이 깨지는 문제의 우회 레이어.
//
// 실기기 계측(2026-07-14, macOS WKWebView + 한글 2벌식)으로 확인한 실제 메커니즘:
//
// 1) xterm의 hidden textarea는 `opacity:0`(+오프스크린)인데, WebKit은 완전히
//    보이지 않는 편집 요소에 입력기(IME)를 붙이지 않는다. Chromium은 붙여 주기
//    때문에 VS Code(Electron)에서는 같은 코드가 정상 동작한다.
// 2) 가시성을 확보해 IME가 붙어도, macOS 한글 IM은 WebKit에서 DOM composition
//    이벤트(compositionstart/update/end)를 쓰지 않고 **insertText 치환 흐름**으로
//    조합을 전달한다:
//      beforeinput insertText            "ㅎ"   ← 새 음절 시작
//      beforeinput insertReplacementText "하"   ← 조합 중 음절 치환
//      beforeinput insertReplacementText "한"
//      beforeinput insertText            "ㄱ"   ← 다음 음절 시작 = 앞 음절("한") 확정
//    xterm은 composition 이벤트 전제로 설계되어 insertText만 PTY로 전달한다.
//    → 첫 자모("ㅎ")만 새어 나가고 완성 음절("한","글")은 전송되지 않는다.
//    이것이 "한글 자모 분해·유실"의 정체다 (xterm.js #5894·#5887·#1939 계열).
//
// 우회 전략 (xterm 코드는 수정하지 않는다):
//  A. 가시성 확보 — textarea에 최소 불투명도를 줘 WebKit이 IME를 붙이게 한다.
//  B. insertText 어댑터 — beforeinput/input을 문서 캡처 단계에서 가로채(xterm보다
//     먼저) 조합 중 음절을 pending 버퍼에 유지하고, 음절 확정 시점(다음 insertText
//     시작·일반 keydown·blur)에만 term.input()으로 완성 음절을 PTY에 흘려보낸다.
//     비ASCII insertText/insertReplacementText는 stopPropagation으로 xterm의
//     자체 전달(_inputEvent)을 차단해 자모 유출을 막는다.
//  C. keyCode 229 가드 — IME가 만든 keydown을 xterm 키 파이프라인에서 제외한다.
//  D. DOM composition 이벤트를 실제로 쓰는 IME(일부 일본어 IM 등)는 건드리지
//     않는다(isComposing인 이벤트는 xterm CompositionHelper에 위임). 그 경로의
//     기존 방어(조합 중 value 리셋 무시·textarea 이동 차단)도 유지한다.
//
// 한계(수용): pending 음절은 다음 경계에서 흘러가므로 마지막 음절의 터미널 에코가
// 한 이벤트만큼 늦다. 실패 시 원본 xterm 동작으로 폴백한다(터미널 자체는 유지).

/** attachImeStabilizer가 필요로 하는 xterm Terminal의 최소 표면 (테스트 용이성). */
export interface ImeStabilizerTarget {
  textarea: HTMLTextAreaElement | undefined;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  /** 사용자 입력으로 PTY에 데이터를 흘려보낸다 (onData 경유 — 기존 배선 재사용). */
  input(data: string, wasUserInput?: boolean): void;
  /** 조합 프리뷰 스타일을 터미널과 맞추기 위한 옵션 (xterm Terminal.options 부분집합). */
  options?: {
    fontSize?: number;
    fontFamily?: string;
    theme?: { background?: string; foreground?: string };
  };
}

/**
 * 조합이 만든 keydown(keyCode 229 또는 isComposing)을 xterm 키 파이프라인에서
 * 제외할지 판정한다. 순수 함수 — 단위 테스트 대상.
 */
export function shouldBypassXtermKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** 수식 키 — 자모 조합의 일부(Shift+ㅖ, 된소리 ㄲ 등)로 눌리므로 조합 경계가 아니다. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/**
 * pending 음절을 확정(flush)해야 하는 조합 경계 keydown인지 판정한다.
 * 순수 함수 — 단위 테스트 대상.
 *
 * IME 처리 키(keyCode 229/isComposing)는 조합 내부 이벤트라 경계가 아니고,
 * 수식 키는 다음 자모를 위해 조합 도중에 눌린다 — 경계로 오판해 flush하면
 * 시작 자모가 낱자로 새어 나간다("계획해" 타이핑 시 계=ㄱ+Shift+ㅖ의
 * Shift keydown이 pending "ㄱ"를 조기 커밋해 "ㄱ계획해"가 되는 버그).
 */
export function isCompositionBoundaryKey(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "key">,
): boolean {
  return event.keyCode !== 229 && !event.isComposing && !MODIFIER_KEYS.has(event.key);
}

/**
 * Blink(Chromium)는 IME가 정상이므로 손대지 않고, WebKit 계열에서만 활성화한다.
 * WKWebView UA에는 AppleWebKit이 있고 Chrome/Chromium/Edg 마커가 없다.
 */
export function isWebKitEngine(userAgent: string): boolean {
  return /AppleWebKit/i.test(userAgent) && !/Chrome|Chromium|Edg\//i.test(userAgent);
}

/** IME 조합 텍스트(비ASCII) 판정 — ASCII는 keydown/keypress 경로가 이미 처리한다. */
export function isImeText(data: string): boolean {
  return [...data].some((ch) => ch.charCodeAt(0) > 0x7f);
}

/** 조합 중 이동을 막을 위치/크기 계열 스타일 속성 (DOM composition 경로 방어용). */
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
  /** 이벤트 리스너를 붙일 문서 (테스트용). 기본값은 전역 document. */
  doc?: Document;
}

/**
 * xterm Terminal(term.open 이후)에 IME 어댑터를 부착한다. 해제 함수를 반환한다.
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
  const doc = options.doc ?? textarea.ownerDocument;

  // ---- (A) 가시성 확보 — WebKit이 IME를 붙이도록 완전 투명을 피한다 ----------
  // 시각적으로는 여전히 식별 불가 수준이며, 위치·크기는 xterm이 커서에 맞춘다.
  try {
    textarea.style.opacity = "0.05";
  } catch {
    /* 스타일 접근이 막힌 환경이면 이 단계만 포기 */
  }

  // ---- (C) keyCode 229 가드 -------------------------------------------------
  term.attachCustomKeyEventHandler((ev) => !shouldBypassXtermKey(ev));

  // ---- (B) insertText 어댑터 ------------------------------------------------
  // 문서 캡처 단계 리스너는 xterm의 textarea(at-target) 리스너보다 먼저 실행된다.
  // ---- 조합 프리뷰 ----------------------------------------------------------
  // pending 음절은 확정 전까지 PTY로 가지 않아 화면에 보이지 않는다. xterm이
  // textarea를 항상 커서 셀에 동기화해 두므로(_syncTextArea), 같은 좌표에
  // 터미널과 같은 서체의 오버레이를 띄워 조합 중 음절을 보여준다.
  const preview = doc.createElement("span");
  preview.className = "xterm-ime-preview";
  {
    const opt = term.options ?? {};
    Object.assign(preview.style, {
      position: "absolute",
      display: "none",
      zIndex: "10",
      pointerEvents: "none",
      whiteSpace: "pre",
      fontFamily: opt.fontFamily ?? "monospace",
      fontSize: `${opt.fontSize ?? 14}px`,
      color: opt.theme?.foreground ?? "#ffffff",
      background: opt.theme?.background ?? "#000000",
      textDecoration: "underline",
    });
  }
  textarea.parentElement?.appendChild(preview);
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const updatePreview = () => {
    if (!pending) {
      preview.style.display = "none";
      preview.textContent = "";
      return;
    }
    preview.textContent = pending;
    // textarea의 인라인 스타일(커서 셀 좌표·크기)을 그대로 복사한다.
    preview.style.left = textarea.style.left;
    preview.style.top = textarea.style.top;
    preview.style.height = textarea.style.height;
    preview.style.lineHeight = textarea.style.lineHeight;
    preview.style.display = "block";
  };
  const schedulePreviewResync = () => {
    // 직전 음절 flush의 PTY 에코로 커서가 이동한 뒤 좌표를 한 번 더 맞춘다.
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 80);
  };

  let pending = "";
  const flushPending = () => {
    if (!pending) return;
    const data = pending;
    pending = "";
    updatePreview();
    try {
      term.input(data, true);
    } catch {
      /* 세션 종료 직후 등 — 입력 유실보다 예외 전파가 더 해롭다 */
    }
  };

  const onKeydownCapture = (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.target !== textarea) return;
    // 일반 키(스페이스·엔터·백스페이스·영문 등)가 xterm에 닿기 전에, 조합 중이던
    // 음절을 먼저 PTY로 흘려보내야 순서가 맞는다 ("한글 " ≠ "한 글").
    // 단 수식 키(Shift 등)는 자모 조합의 일부이므로 경계로 취급하지 않는다.
    if (isCompositionBoundaryKey(ev)) flushPending();
  };

  const onBeforeInputCapture = (e: Event) => {
    const ev = e as InputEvent;
    if (ev.target !== textarea || ev.isComposing) return;
    const data = ev.data ?? "";
    if (ev.inputType === "insertText" && data && isImeText(data)) {
      // 새 음절 시작 = 직전 음절 확정. xterm의 자체 전달은 차단한다(자모 유출 방지).
      e.stopPropagation();
      flushPending();
      pending = data;
      updatePreview();
      schedulePreviewResync();
    } else if (ev.inputType === "insertReplacementText" && data) {
      // 조합 중 음절 치환 — pending만 갱신한다.
      e.stopPropagation();
      pending = data;
      updatePreview();
    }
  };

  const onInputCapture = (e: Event) => {
    const ev = e as InputEvent;
    if (ev.target !== textarea || ev.isComposing) return;
    const data = ev.data ?? "";
    // beforeinput에서 처리한 이벤트의 input 단계도 xterm에게서 숨긴다.
    if (
      (ev.inputType === "insertText" && data && isImeText(data)) ||
      (ev.inputType === "insertReplacementText" && data)
    ) {
      e.stopPropagation();
      if (ev.inputType === "insertReplacementText") {
        pending = data;
        updatePreview();
      }
    }
  };

  const onBlur = () => flushPending();

  doc.addEventListener("keydown", onKeydownCapture, true);
  doc.addEventListener("beforeinput", onBeforeInputCapture, true);
  doc.addEventListener("input", onInputCapture, true);
  textarea.addEventListener("blur", onBlur);

  // ---- (D) DOM composition 경로 방어 (조합 이벤트를 쓰는 IME용, 기존 유지) ----
  let composing = false;
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
          if (composing && v === "") return; // 조합 중 xterm의 value 리셋 무시
          set.call(this, v);
        },
      });
      valuePatched = true;
    }
  } catch {
    /* accessor 재정의가 막힌 환경이면 이 방어선만 포기 */
  }

  let stylePatched = false;
  try {
    const realStyle = textarea.style;
    const styleProxy = new Proxy(realStyle, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v === "function") {
          return (...args: unknown[]) => {
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
    /* Proxy/defineProperty가 막힌 환경이면 이 방어선만 포기 */
  }

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    // xterm의 compositionend 처리(setTimeout 0)가 끝난 다음에 방어를 푼다.
    setTimeout(() => {
      composing = false;
    }, 0);
  };
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);

  return () => {
    flushPending();
    clearTimeout(previewTimer);
    preview.remove();
    composing = false;
    doc.removeEventListener("keydown", onKeydownCapture, true);
    doc.removeEventListener("beforeinput", onBeforeInputCapture, true);
    doc.removeEventListener("input", onInputCapture, true);
    textarea.removeEventListener("blur", onBlur);
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
