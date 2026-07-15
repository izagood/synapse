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
// - 핀치(ctrlKey): OS가 델타를 잘게 쪼개 보내므로 10배 민감도로 보상
export function wheelZoomFactor(e: WheelLike): number {
  const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
  return Math.pow(2, -e.deltaY * unit * (e.ctrlKey ? 10 : 1));
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
