// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act, useRef } from "react";
import { useViewerGesture, type ViewerGestureHandlers } from "./useViewerGesture";

/** WebKit GestureEvent 를 흉내낸다 — lib.dom·jsdom 모두 이 타입이 없다. */
function gestureEvent(type: string, scale: number, clientX = 0, clientY = 0): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { scale, clientX, clientY });
  return e;
}

let root: Root | null = null;
let host: HTMLDivElement;
let surface: HTMLDivElement | null = null;

function Surface({ handlers }: { handlers: ViewerGestureHandlers }) {
  const ref = useRef<HTMLDivElement>(null);
  useViewerGesture(ref, handlers);
  return <div ref={ref} data-testid="surface" />;
}

function render(handlers: ViewerGestureHandlers) {
  root = createRoot(host);
  act(() => {
    root!.render(<Surface handlers={handlers} />);
  });
  surface = host.querySelector<HTMLDivElement>("[data-testid=surface]");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  surface = null;
});

// Tauri는 맥에서 WKWebView를 쓰는데, 그 트랙패드 핀치는 ctrl+wheel이 아니라
// 고유 GestureEvent로 온다(실측: 핀치 시 wheel+ctrlKey 0건). 이 경로가 없으면
// 맥에서 이미지/PDF 뷰어의 핀치 줌이 아예 무반응이다.
describe("useViewerGesture — 맥 WKWebView 핀치(GestureEvent)", () => {
  it("gesturechange 로 확대 배율을 전달한다", () => {
    const onZoom = vi.fn();
    render({ onZoom });

    act(() => {
      surface!.dispatchEvent(gestureEvent("gesturestart", 1));
      surface!.dispatchEvent(gestureEvent("gesturechange", 1.5));
    });

    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(1.5, 5);
  });

  it("누적 scale 을 증분 배율로 바꿔 전달한다", () => {
    const onZoom = vi.fn();
    render({ onZoom });

    act(() => {
      surface!.dispatchEvent(gestureEvent("gesturestart", 1));
      surface!.dispatchEvent(gestureEvent("gesturechange", 2));
      surface!.dispatchEvent(gestureEvent("gesturechange", 3)); // 누적 3배 = 직전 대비 1.5배
    });

    expect(onZoom.mock.calls[1][0]).toBeCloseTo(1.5, 5);
  });

  it("gestureend 이후의 이벤트는 무시한다", () => {
    const onZoom = vi.fn();
    render({ onZoom });

    act(() => {
      surface!.dispatchEvent(gestureEvent("gesturestart", 1));
      surface!.dispatchEvent(gestureEvent("gestureend", 2));
      surface!.dispatchEvent(gestureEvent("gesturechange", 4));
    });

    expect(onZoom).not.toHaveBeenCalled();
  });

  it("WebView 자체 페이지 줌이 뜨지 않도록 기본 동작을 막는다", () => {
    render({ onZoom: vi.fn() });

    const start = gestureEvent("gesturestart", 1);
    act(() => {
      surface!.dispatchEvent(start);
    });

    expect(start.defaultPrevented).toBe(true);
  });

  it("언마운트 후에는 제스처를 받지 않는다", () => {
    const onZoom = vi.fn();
    render({ onZoom });
    const el = surface!;

    act(() => root?.unmount());
    root = null;

    el.dispatchEvent(gestureEvent("gesturestart", 1));
    el.dispatchEvent(gestureEvent("gesturechange", 2));

    expect(onZoom).not.toHaveBeenCalled();
  });
});

describe("useViewerGesture — 휠 줌", () => {
  // 이전에는 deltaMode를 무시하고 exp(-deltaY * 0.01)을 하드코딩해, 라인 단위
  // 델타를 주는 환경에서 배율이 어긋났다. 그래프 뷰와 같은 수식을 쓴다.
  it("deltaMode(라인)을 픽셀과 다르게 해석한다", () => {
    const onZoom = vi.fn();
    render({ onZoom });

    act(() => {
      surface!.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -1, deltaMode: 1, ctrlKey: true, cancelable: true }),
      );
      surface!.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -1, deltaMode: 0, ctrlKey: true, cancelable: true }),
      );
    });

    const [lineFactor] = onZoom.mock.calls[0];
    const [pixelFactor] = onZoom.mock.calls[1];
    expect(lineFactor).toBeGreaterThan(pixelFactor);
  });
});
