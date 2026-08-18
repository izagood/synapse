// 그래프 뷰 줌 계산 (순수 함수) — GraphView의 휠/핀치 핸들러가 사용한다.
// 휠/제스처 배율 계산은 뷰어(이미지·PDF)와 공유한다 — viewer-zoom/zoomMath 참조.
export { wheelZoomFactor, gestureZoomFactor } from "../viewer-zoom/zoomMath";
export type { WheelLike, WebKitGestureEvent } from "../viewer-zoom/zoomMath";

export interface ZoomView {
  k: number;
  tx: number;
  ty: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// (vx, vy)를 앵커로 factor만큼 줌 — 커서 아래 지점이 화면에 고정된다.
export function applyZoom(
  view: ZoomView,
  vx: number,
  vy: number,
  factor: number,
  minZoom: number,
  maxZoom: number,
): ZoomView {
  const k = clamp(view.k * factor, minZoom, maxZoom);
  const f = k / view.k;
  return { k, tx: vx - (vx - view.tx) * f, ty: vy - (vy - view.ty) * f };
}
