import { resolveAssetUrl } from "../../ipc/ipc";
import {
  HIGHLIGHTER_OPACITY,
  strokeToSvgPath,
  strokesOnPage,
  type DrawDoc,
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
 * (회전된 페이지(rotation≠0)는 v1에서 보정하지 않는다 — 사이드카 미리보기는 정확.)
 */
export async function buildBakedPdf(
  originalBytes: Uint8Array,
  doc: DrawDoc,
): Promise<Uint8Array> {
  const { PDFDocument, rgb, LineCapStyle } = await import("pdf-lib");
  const pdf = await PDFDocument.load(originalBytes);
  const pages = pdf.getPages();

  for (let i = 0; i < pages.length; i++) {
    const strokes = strokesOnPage(doc, i + 1);
    if (strokes.length === 0) continue;
    const page = pages[i];
    const { height } = page.getSize();
    for (const stroke of strokes) {
      const d = strokeToSvgPath(stroke.points);
      if (!d) continue;
      const { r, g, b } = hexToRgb01(stroke.color);
      page.drawSvgPath(d, {
        x: 0,
        y: height,
        scale: 1,
        borderColor: rgb(r, g, b),
        borderWidth: stroke.width,
        borderOpacity: stroke.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
        borderLineCap: LineCapStyle.Round,
      });
    }
  }
  return pdf.save();
}
