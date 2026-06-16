import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useT } from "../../i18n";
import { useViewerGesture } from "../viewer-zoom/useViewerGesture";
import { ZoomControls } from "../viewer-zoom/ZoomControls";
import { clampScale, MAX_SCALE, MIN_SCALE } from "../viewer-zoom/zoomMath";

// 워커는 Vite가 앱 오리진(self)에서 서빙하는 에셋으로 번들한다 → CSP default-src 'self' 통과.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// CJK 등 비임베드 폰트용 cmap/표준폰트. predev/prebuild 에서 public/pdfjs 로 복사된다.
const CMAP_URL = "/pdfjs/cmaps/";
const STANDARD_FONTS_URL = "/pdfjs/standard_fonts/";
const PAGE_PADDING = 16; // .pdf-pages 좌우 패딩(px)과 일치시켜 fit 폭을 계산

// 네이티브 iframe 대신 pdf.js로 캔버스 렌더링한다. 트랙패드 핀치(ctrl+휠)/터치 핀치로
// 확대·축소하면 해당 배율로 다시 렌더해 항상 선명하다. 패닝은 네이티브 스크롤.
export function PdfViewer({ path }: { path: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const firstPageWidthRef = useRef(0); // scale 1 에서의 첫 페이지 폭(px)
  const zoomRef = useRef(1); // fit 대비 배율
  const renderTokenRef = useRef(0);
  const renderTasksRef = useRef<RenderTask[]>([]);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const t = useT();

  // 현재 zoom·컨테이너 폭 기준으로 모든 페이지를 캔버스에 렌더한다.
  const renderAll = useCallback(async () => {
    const doc = docRef.current;
    const host = pagesRef.current;
    const scroll = scrollRef.current;
    if (!doc || !host || !scroll || firstPageWidthRef.current <= 0) return;

    const token = ++renderTokenRef.current;
    // 진행 중인 렌더는 취소(같은 캔버스 중복 render 방지).
    renderTasksRef.current.forEach((task) => task.cancel());
    renderTasksRef.current = [];

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const avail = Math.max(1, scroll.clientWidth - PAGE_PADDING * 2);
    const fitScale = avail / firstPageWidthRef.current;
    const effective = fitScale * zoomRef.current;

    for (let i = 1; i <= doc.numPages; i++) {
      if (token !== renderTokenRef.current) return; // 더 새 렌더로 교체됨
      const page = await doc.getPage(i);
      if (token !== renderTokenRef.current) return;
      const viewport = page.getViewport({ scale: effective * dpr });

      let canvas = host.querySelector<HTMLCanvasElement>(`canvas[data-page="${i}"]`);
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.dataset.page = String(i);
        canvas.className = "pdf-page";
        host.appendChild(canvas);
      }
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const task = page.render({ canvasContext: ctx, viewport });
      renderTasksRef.current.push(task);
      try {
        await task.promise;
      } catch {
        // 취소된 렌더(RenderingCancelledException)는 무시한다.
      }
    }

    // 줌 앵커를 맞추기 위한 스크롤 위치 적용(페이지 크기 확정 후).
    if (token === renderTokenRef.current && pendingScrollRef.current) {
      scroll.scrollLeft = pendingScrollRef.current.left;
      scroll.scrollTop = pendingScrollRef.current.top;
      pendingScrollRef.current = null;
    }
  }, []);

  // 문서 로드.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    firstPageWidthRef.current = 0;
    zoomRef.current = 1;
    setZoom(1);
    if (pagesRef.current) pagesRef.current.innerHTML = "";

    const task = pdfjs.getDocument({
      url: resolveAssetUrl(path),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
    });

    task.promise
      .then(async (doc) => {
        if (cancelled) {
          await doc.destroy();
          return;
        }
        docRef.current = doc;
        const page = await doc.getPage(1);
        if (cancelled) return;
        firstPageWidthRef.current = page.getViewport({ scale: 1 }).width;
        setStatus("ready"); // ready 마운트 후 아래 effect 가 renderAll 을 호출
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      renderTasksRef.current.forEach((tk) => tk.cancel());
      renderTasksRef.current = [];
      void task.destroy();
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, [path]);

  // status/zoom 변화 시 다시 렌더(연속 핀치는 디바운스).
  useEffect(() => {
    if (status !== "ready") return;
    const id = setTimeout(() => void renderAll(), 60);
    return () => clearTimeout(id);
  }, [status, zoom, renderAll]);

  // 컨테이너 폭이 바뀌면(사이드바 토글 등) fit 폭이 달라지므로 재렌더.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void renderAll());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [renderAll]);

  // 앵커(커서/핀치 중점) 아래 지점을 고정한 채 zoom 변경.
  const zoomAtPoint = useCallback((factor: number, localX: number, localY: number) => {
    const scroll = scrollRef.current;
    const old = zoomRef.current;
    const next = clampScale(old * factor, MIN_SCALE, MAX_SCALE);
    if (!scroll || next === old) return;
    const r = next / old;
    pendingScrollRef.current = {
      left: (scroll.scrollLeft + localX) * r - localX,
      top: (scroll.scrollTop + localY) * r - localY,
    };
    zoomRef.current = next;
    setZoom(next);
  }, []);

  useViewerGesture(scrollRef, { onZoom: zoomAtPoint });

  const zoomByButton = (factor: number) => {
    const el = scrollRef.current;
    zoomAtPoint(factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
  };

  const reset = () => {
    pendingScrollRef.current = null;
    zoomRef.current = 1;
    setZoom(1);
  };

  return (
    <div className="pdf-viewer">
      {status === "error" && (
        <div className="preview-placeholder">
          <p className="error">{t("viewer.pdfError")}</p>
        </div>
      )}
      {status === "loading" && (
        <div className="preview-placeholder">
          <p>{t("viewer.preparing")}</p>
        </div>
      )}
      <div ref={scrollRef} className="pdf-scroll" hidden={status !== "ready"}>
        <div ref={pagesRef} className="pdf-pages" />
      </div>
      {status === "ready" && (
        <ZoomControls
          scale={zoom}
          onZoomIn={() => zoomByButton(1.4)}
          onZoomOut={() => zoomByButton(1 / 1.4)}
          onReset={reset}
        />
      )}
    </div>
  );
}
