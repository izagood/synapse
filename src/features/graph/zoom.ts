// 그래프 뷰 줌 계산 (순수 함수) — GraphView의 휠/핀치 핸들러가 사용한다.

export interface ZoomView {
  k: number;
  tx: number;
  ty: number;
}

interface WheelLike {
  deltaY: number;
  deltaMode?: number;
  ctrlKey?: boolean;
}

// 델타 크기에 비례한 지수 배율 (d3-zoom 관례).
// 고정 스텝(±15%)은 이벤트를 수십 개 쏟아내는 트랙패드/핀치에서 폭주한다.
// - deltaMode 0(픽셀): 0.002 → 휠 한 칸(120px)당 약 1.18배
// - deltaMode 1(라인): 라인당 0.05
// - ctrlKey: Chromium 계열 WebView(Windows/Linux)는 핀치를 ctrl+wheel로
//   보내는데 델타를 잘게 쪼개므로 10배 민감도로 보상. 맥 WKWebView의 핀치는
//   wheel이 아니라 GestureEvent로 온다 → gestureZoomFactor 참고.
export function wheelZoomFactor(e: WheelLike): number {
  const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
  return Math.pow(2, -e.deltaY * unit * (e.ctrlKey ? 10 : 1));
}

// WebKit(맥 Safari/WKWebView) 전용 GestureEvent의 scale은 "제스처 시작 시점
// 기준 누적 배율"이다. 직전 scale과의 비로 나눠 증분 배율을 만들어 applyZoom에
// 넘긴다. 유효하지 않은 scale(0·음수·NaN)은 1(변화 없음)로 처리한다.
export function gestureZoomFactor(scale: number, prevScale: number): number {
  return scale > 0 && prevScale > 0 ? scale / prevScale : 1;
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
