import { resolveAssetUrl } from "../../ipc/ipc";
import {
  effectiveOpacity,
  shapesOnPage,
  strokeToSvgPath,
  type DrawDoc,
  type LineShape,
  type PathShape,
  type RectLikeShape,
  type Shape,
} from "./drawDoc";

// pdf-lib 는 무거우므로(수백 KB) 굽기를 실행할 때만 동적으로 불러온다.

/** "#rgb"/"#rrggbb" → {r,g,b} 0..1. 못 읽으면 검정. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** Uint8Array → base64 (IPC 전송용). 큰 파일도 안전하게 청크 처리. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** asset 프로토콜로 원본 PDF 바이트를 읽는다. */
export async function fetchPdfBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(resolveAssetUrl(path));
  if (!res.ok) throw new Error(`failed to fetch pdf: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 원본 PDF 바이트에 드로잉을 합성해 새 PDF 바이트를 만든다.
 * 좌표는 scale 1 pdf.js 뷰포트 기준(top-left, y-down)이고, pdf-lib drawSvgPath 에
 * y=pageHeight 기준점을 주면 페이지 좌표(bottom-left, y-up)로 올바르게 매핑된다.
 * (회전된 페이지(rotation≠0)는 보정하지 않는다 — 사이드카 미리보기는 정확.)
 *
 * 도형 종류별 베이크는 bakeShape 디스패처가 맡는다(단계별로 case 가 늘어난다).
 */
export async function buildBakedPdf(
  originalBytes: Uint8Array,
  doc: DrawDoc,
): Promise<Uint8Array> {
  const lib = await import("pdf-lib");
  const { PDFDocument, rgb, LineCapStyle } = lib;
  const pdf = await PDFDocument.load(originalBytes);
  const pages = pdf.getPages();

  // pdf-lib 의 rgb/LineCapStyle 을 클로저로 캡처해 도형별 베이커에 넘긴다.
  type Page = (typeof pages)[number];
  const toRgb = (hex: string) => {
    const { r, g, b } = hexToRgb01(hex);
    return rgb(r, g, b);
  };
  // scale1(top-left, y-down) → pdf 페이지 좌표(bottom-left, y-up).
  const flipY = (height: number, y: number) => height - y;

  const bakePath = (page: Page, height: number, path: PathShape) => {
    const d = strokeToSvgPath(path.points);
    if (!d) return;
    page.drawSvgPath(d, {
      x: 0,
      y: height,
      scale: 1,
      borderColor: toRgb(path.color),
      borderWidth: path.width,
      borderOpacity: effectiveOpacity(path),
      borderLineCap: LineCapStyle.Round,
    });
  };

  const bakeLine = (page: Page, height: number, line: LineShape) => {
    const col = toRgb(line.color);
    const op = effectiveOpacity(line);
    const start = { x: line.a[0], y: flipY(height, line.a[1]) };
    const end = { x: line.b[0], y: flipY(height, line.b[1]) };
    const seg = { thickness: line.width, color: col, opacity: op, lineCap: LineCapStyle.Round };
    page.drawLine({ start, end, ...seg });
    if (line.type === "arrow") {
      // 화살촉: pdf 좌표(y-up)에서 끝점 뒤로 두 갈래.
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const len = Math.max(8, line.width * 3);
      const spread = Math.PI / 7;
      const h1 = {
        x: end.x - len * Math.cos(angle - spread),
        y: end.y - len * Math.sin(angle - spread),
      };
      const h2 = {
        x: end.x - len * Math.cos(angle + spread),
        y: end.y - len * Math.sin(angle + spread),
      };
      page.drawLine({ start: end, end: h1, ...seg });
      page.drawLine({ start: end, end: h2, ...seg });
    }
  };

  const bakeRectLike = (page: Page, height: number, shape: RectLikeShape) => {
    const [x, y, w, h] = shape.rect;
    const op = effectiveOpacity(shape);
    const fillCol = shape.fill ? toRgb(shape.fill) : undefined;
    const strokeCol = shape.stroke ? toRgb(shape.stroke) : undefined;
    const common = {
      color: fillCol,
      opacity: fillCol ? op : undefined,
      borderColor: strokeCol,
      borderWidth: strokeCol ? shape.width : undefined,
      borderOpacity: strokeCol ? op : undefined,
    };
    if (shape.type === "ellipse") {
      // drawEllipse 의 x,y 는 중심. (둥근 모서리 radius 는 베이크에서 무시 — 화면 전용)
      page.drawEllipse({
        x: x + w / 2,
        y: flipY(height, y + h / 2),
        xScale: w / 2,
        yScale: h / 2,
        ...common,
      });
    } else {
      page.drawRectangle({
        x,
        y: flipY(height, y + h), // 좌하단 모서리
        width: w,
        height: h,
        ...common,
      });
    }
  };

  const bakeShape = (page: Page, height: number, shape: Shape) => {
    switch (shape.type) {
      case "path":
        bakePath(page, height, shape);
        break;
      case "line":
      case "arrow":
        bakeLine(page, height, shape);
        break;
      case "rect":
      case "ellipse":
        bakeRectLike(page, height, shape);
        break;
    }
  };

  for (let i = 0; i < pages.length; i++) {
    const shapes = shapesOnPage(doc, i + 1);
    if (shapes.length === 0) continue;
    const page = pages[i];
    const { height } = page.getSize();
    for (const shape of shapes) bakeShape(page, height, shape);
  }
  return pdf.save();
}
