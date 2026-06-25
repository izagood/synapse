import { HIGHLIGHTER_OPACITY, type PathShape, type Shape } from "./drawDoc";

/**
 * 자유곡선 한 개를 캔버스에 그린다. 컨텍스트는 이미 scale 1 좌표계로 변환돼
 * 있어야 한다(setTransform(s,0,0,s,0,0), s = effective*dpr). 그러면 좌표·굵기
 * 모두 그대로 scale 1 단위로 넘기면 된다.
 */
function drawPath(ctx: CanvasRenderingContext2D, path: PathShape): void {
  const pts = path.points;
  if (pts.length < 2) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = path.color;
  ctx.lineWidth = path.width;
  ctx.globalAlpha = path.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1;

  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  if (pts.length === 2) {
    // 단일 점: 둥근 캡이 점처럼 찍히도록 같은 자리로 미세 이동.
    ctx.lineTo(pts[0] + 0.01, pts[1] + 0.01);
  } else {
    for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  }
  ctx.stroke();
  ctx.restore();
}

/** 한 도형을 type 별로 분기해 그린다. 단계별로 case 가 늘어난다. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  switch (shape.type) {
    case "path":
      drawPath(ctx, shape);
      break;
  }
}

/**
 * 오버레이 캔버스를 비우고 그 페이지의 모든 도형을 다시 그린다.
 * scale 은 effective 배율(fit*zoom), dpr 은 백킹스토어 배율.
 * extra 는 진행 중인(아직 커밋 안 된) 도형 — 있으면 마지막에 덧그린다.
 */
export function redrawOverlay(
  canvas: HTMLCanvasElement,
  shapes: Shape[],
  scale: number,
  dpr: number,
  extra?: Shape | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = scale * dpr;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  for (const shape of shapes) drawShape(ctx, shape);
  if (extra) drawShape(ctx, extra);
}
