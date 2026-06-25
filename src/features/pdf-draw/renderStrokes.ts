import {
  effectiveOpacity,
  shapeBounds,
  smoothPath,
  type LineShape,
  type PathShape,
  type RectLikeShape,
  type Shape,
} from "./drawDoc";

/** 선택 표시(테두리·핸들) 색. */
const SELECT_COLOR = "#2563eb";
/** 코너 핸들 한 변의 절반(화면 CSS px). */
const HANDLE_HALF_PX = 5;

/**
 * 자유곡선 한 개를 캔버스에 그린다. 컨텍스트는 이미 scale 1 좌표계로 변환돼
 * 있어야 한다(setTransform(s,0,0,s,0,0), s = effective*dpr). 그러면 좌표·굵기
 * 모두 그대로 scale 1 단위로 넘기면 된다.
 */
function drawPath(ctx: CanvasRenderingContext2D, path: PathShape): void {
  const sp = smoothPath(path.points);
  if (!sp) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = path.color;
  ctx.lineWidth = path.width;
  ctx.globalAlpha = effectiveOpacity(path);

  // 베이크(strokeToSvgPath)와 같은 2차 베지어 곡선으로 그린다.
  ctx.beginPath();
  ctx.moveTo(sp.startX, sp.startY);
  for (const s of sp.segs) ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y);
  ctx.stroke();
  ctx.restore();
}

/** 화살표 머리: 끝점 b 에서 뒤로 두 갈래 선을 그린다. */
function drawArrowHead(ctx: CanvasRenderingContext2D, line: LineShape): void {
  const [ax, ay] = line.a;
  const [bx, by] = line.b;
  const angle = Math.atan2(by - ay, bx - ax);
  const len = Math.max(8, line.width * 3); // 머리 길이
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - len * Math.cos(angle - spread), by - len * Math.sin(angle - spread));
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - len * Math.cos(angle + spread), by - len * Math.sin(angle + spread));
  ctx.stroke();
}

function drawLine(ctx: CanvasRenderingContext2D, line: LineShape): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = line.color;
  ctx.lineWidth = line.width;
  ctx.globalAlpha = effectiveOpacity(line);
  ctx.beginPath();
  ctx.moveTo(line.a[0], line.a[1]);
  ctx.lineTo(line.b[0], line.b[1]);
  ctx.stroke();
  if (line.type === "arrow") drawArrowHead(ctx, line);
  ctx.restore();
}

function drawRectLike(ctx: CanvasRenderingContext2D, shape: RectLikeShape): void {
  const [x, y, w, h] = shape.rect;
  ctx.save();
  ctx.globalAlpha = effectiveOpacity(shape);
  ctx.beginPath();
  if (shape.type === "ellipse") {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    const r = Math.min(shape.radius ?? 0, w / 2, h / 2);
    if (r > 0) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  if (shape.fill) {
    ctx.fillStyle = shape.fill;
    ctx.fill();
  }
  if (shape.stroke) {
    ctx.strokeStyle = shape.stroke;
    ctx.lineWidth = shape.width;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.restore();
}

/** 한 도형을 type 별로 분기해 그린다. 단계별로 case 가 늘어난다. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  switch (shape.type) {
    case "path":
      drawPath(ctx, shape);
      break;
    case "line":
    case "arrow":
      drawLine(ctx, shape);
      break;
    case "rect":
    case "ellipse":
      drawRectLike(ctx, shape);
      break;
  }
}

/**
 * 선택된 도형의 bbox 점선 + 코너 핸들을 그린다. 핸들은 화면 CSS px 고정 크기라
 * scale 로 역산한다(줌과 무관하게 일정). 이 표시는 저장/베이크 대상이 아니다.
 */
function drawSelection(ctx: CanvasRenderingContext2D, shape: Shape, scale: number): void {
  const [x, y, w, h] = shapeBounds(shape);
  const px = 1 / (scale || 1); // 화면 1 CSS px → ctx 단위
  const half = HANDLE_HALF_PX * px;
  ctx.save();
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = px;
  ctx.setLineDash([4 * px, 3 * px]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  for (const [cx, cy] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ]) {
    ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
  }
  ctx.restore();
}

/**
 * 오버레이 캔버스를 비우고 그 페이지의 모든 도형을 다시 그린다.
 * scale 은 effective 배율(fit*zoom), dpr 은 백킹스토어 배율.
 * extra 는 진행 중인(아직 커밋 안 된) 도형 — 있으면 마지막에 덧그린다.
 * selected 가 있으면 그 위에 선택 표시(핸들)를 얹는다.
 */
export function redrawOverlay(
  canvas: HTMLCanvasElement,
  shapes: Shape[],
  scale: number,
  dpr: number,
  extra?: Shape | null,
  selected?: Shape | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = scale * dpr;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  for (const shape of shapes) drawShape(ctx, shape);
  if (extra) drawShape(ctx, extra);
  if (selected) drawSelection(ctx, selected, scale);
}
