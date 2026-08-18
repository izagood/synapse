import { useEffect, useRef } from "react";
import {
  GESTURE_EVENTS,
  distance,
  gestureZoomFactor,
  midpoint,
  wheelZoomFactor,
  type WebKitGestureEvent,
} from "./zoomMath";

export interface ViewerGestureHandlers {
  /** factor 배 줌. (localX, localY)는 ref 요소 좌상단 기준 앵커 좌표. */
  onZoom: (factor: number, localX: number, localY: number) => void;
  /** 드래그/휠 패닝(px 델타). 미지정이면 패닝 비활성. */
  onPan?: (dx: number, dy: number) => void;
  onPanStart?: () => void;
  onPanEnd?: () => void;
  /** 단일 포인터 드래그·일반 휠을 패닝으로 처리할지. 보통 "확대됐을 때만" true. */
  panEnabled?: () => boolean;
}

// 트랙패드 핀치가 들어오는 경로는 엔진마다 다르다:
// - Chromium 계열 WebView(Windows/Linux): ctrl(+meta) wheel
// - WebKit(맥 Safari/WKWebView): 고유 GestureEvent (실측: 핀치 시 wheel+ctrlKey 0건)
// 터치스크린 핀치는 두 개의 포인터로 들어온다.
// Tauri는 맥에서 WKWebView를 쓰므로 GestureEvent 경로가 없으면 맥에서 핀치 줌이
// 아예 동작하지 않는다. 세 경로를 모두 받아 onZoom 으로 정규화한다.
// wheel/touch 기본 동작을 막아야 하므로 passive:false 로 직접 리스너를 단다.
export function useViewerGesture(
  ref: React.RefObject<HTMLElement | null>,
  handlers: ViewerGestureHandlers,
): void {
  const hRef = useRef(handlers);
  hRef.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const local = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onWheel = (e: WheelEvent) => {
      const h = hRef.current;
      if (e.ctrlKey || e.metaKey) {
        // 트랙패드 핀치 또는 ctrl+휠 → 줌
        e.preventDefault();
        const p = local(e.clientX, e.clientY);
        // 배율 계산은 그래프 뷰와 공유한다(deltaMode·ctrlKey 보정 포함).
        h.onZoom(wheelZoomFactor(e), p.x, p.y);
      } else if (h.panEnabled?.() && h.onPan) {
        // 확대 상태에서 일반 휠/투핑거 스크롤 → 패닝
        e.preventDefault();
        h.onPan(-e.deltaX, -e.deltaY);
      }
    };

    // 활성 포인터들(터치/마우스). 핀치 거리·중점 추적용.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let panning = false;
    let last = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const h = hRef.current;
      if (pointers.size === 2) {
        // 두 번째 포인터 → 핀치 시작. 두 포인터 모두 캡처해 추적을 보장한다.
        for (const id of pointers.keys()) el.setPointerCapture?.(id);
        const [a, b] = [...pointers.values()];
        pinchDist = distance(a.x, a.y, b.x, b.y);
        panning = false;
      } else if (pointers.size === 1 && h.panEnabled?.() && h.onPan) {
        // 패닝이 활성일 때만 캡처한다. (PDF처럼 네이티브 스크롤을 쓰는 뷰어는
        // 단일 포인터를 가로채지 않아야 한 손가락 스크롤이 동작한다.)
        el.setPointerCapture?.(e.pointerId);
        panning = true;
        last = { x: e.clientX, y: e.clientY };
        h.onPanStart?.();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const h = hRef.current;

      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = distance(a.x, a.y, b.x, b.y);
        if (pinchDist > 0 && dist > 0) {
          const mid = midpoint(a.x, a.y, b.x, b.y);
          const p = local(mid.x, mid.y);
          h.onZoom(dist / pinchDist, p.x, p.y);
        }
        pinchDist = dist;
        return;
      }

      if (panning && h.onPan) {
        h.onPan(e.clientX - last.x, e.clientY - last.y);
        last = { x: e.clientX, y: e.clientY };
      }
    };

    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      el.releasePointerCapture?.(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0 && panning) {
        panning = false;
        hRef.current.onPanEnd?.();
      }
    };

    // 맥 WKWebView 핀치 — GestureEvent.scale은 제스처 시작 기준 누적 배율이라
    // 직전 값과의 비로 증분 배율을 만든다. preventDefault 로 WebView 자체 페이지
    // 줌을 막지 않으면 뷰어 대신 앱 전체가 확대된다.
    let prevScale = 0;
    const onGesture = (e: Event) => {
      const g = e as WebKitGestureEvent;
      e.preventDefault();
      if (e.type === "gesturestart") {
        prevScale = g.scale > 0 ? g.scale : 1;
        return;
      }
      if (e.type === "gestureend") {
        prevScale = 0;
        return;
      }
      if (!prevScale) return;
      const p = local(g.clientX, g.clientY);
      hRef.current.onZoom(gestureZoomFactor(g.scale, prevScale), p.x, p.y);
      prevScale = g.scale;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    for (const type of GESTURE_EVENTS) {
      el.addEventListener(type, onGesture, { passive: false });
    }
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);

    return () => {
      el.removeEventListener("wheel", onWheel);
      for (const type of GESTURE_EVENTS) el.removeEventListener(type, onGesture);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endPointer);
      el.removeEventListener("pointercancel", endPointer);
    };
  }, [ref]);
}
