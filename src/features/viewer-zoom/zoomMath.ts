// 이미지/PDF 뷰어가 공유하는 핀치 줌 수학. DOM·React에 의존하지 않는 순수 함수만
// 모아 단위 테스트가 가능하도록 분리한다.

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return clamp(scale, min, max);
}

export interface Transform {
  scale: number;
  /** translate, surface-local px. transform-origin 은 0 0 (좌상단) 기준. */
  x: number;
  y: number;
}

export const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

/**
 * 앵커 (ax, ay)(surface 좌상단 기준 로컬 좌표)가 화면에서 고정된 채로 scale 을
 * factor 배 한다. 핀치/휠 줌에서 "손가락(커서) 아래 지점이 그대로 머무는" 동작.
 */
export function zoomAt(
  t: Transform,
  factor: number,
  ax: number,
  ay: number,
  min = MIN_SCALE,
  max = MAX_SCALE,
): Transform {
  const next = clampScale(t.scale * factor, min, max);
  const k = next / t.scale;
  return {
    scale: next,
    x: ax - k * (ax - t.x),
    y: ay - k * (ay - t.y),
  };
}

/**
 * 콘텐츠가 뷰포트를 항상 덮도록 translate 를 제한한다(여백/거터 방지). scale 이 1 이면
 * 자동으로 0(가운데 정렬)으로 수렴한다. 콘텐츠는 scale 1 에서 뷰포트와 동일 크기라고
 * 가정한다(이미지/PDF 모두 콘텐츠 박스가 뷰포트를 채우는 구조).
 */
export function clampTranslate(t: Transform, vw: number, vh: number): Transform {
  const minX = Math.min(0, vw - t.scale * vw);
  const minY = Math.min(0, vh - t.scale * vh);
  return {
    scale: t.scale,
    x: clamp(t.x, minX, 0),
    y: clamp(t.y, minY, 0),
  };
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function midpoint(ax: number, ay: number, bx: number, by: number): { x: number; y: number } {
  return { x: (ax + bx) / 2, y: (ay + by) / 2 };
}

export function isZoomed(t: Transform): boolean {
  return t.scale > MIN_SCALE + 1e-3;
}
