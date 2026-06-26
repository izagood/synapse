// 화면 좌표 = world * k + t.  (GraphView 의 <g transform="translate(t) scale(k)"> 와 동일한 모델)
export interface Camera { k: number; tx: number; ty: number }
export const IDENTITY: Camera = { k: 1, tx: 0, ty: 0 };

export function worldToScreen(cam: Camera, x: number, y: number) {
  return { x: x * cam.k + cam.tx, y: y * cam.k + cam.ty };
}
export function screenToWorld(cam: Camera, x: number, y: number) {
  return { x: (x - cam.tx) / cam.k, y: (y - cam.ty) / cam.k };
}
export function zoomAround(
  cam: Camera, sx: number, sy: number, factor: number, min: number, max: number,
): Camera {
  const k = Math.max(min, Math.min(max, cam.k * factor));
  const f = k / cam.k;
  return { k, tx: sx - (sx - cam.tx) * f, ty: sy - (sy - cam.ty) * f };
}
