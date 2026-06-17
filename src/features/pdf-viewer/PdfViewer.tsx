import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useT } from "../../i18n";
import { useViewerGesture } from "../viewer-zoom/useViewerGesture";
import { ZoomControls } from "../viewer-zoom/ZoomControls";
import { anchoredScroll, clampScale, MAX_SCALE, previewSize } from "../viewer-zoom/zoomMath";

// 워커는 Vite가 앱 오리진(self)에서 서빙하는 에셋으로 번들한다 → CSP default-src 'self' 통과.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// CJK 등 비임베드 폰트용 cmap/표준폰트. predev/prebuild 에서 public/pdfjs 로 복사된다.
const CMAP_URL = "/pdfjs/cmaps/";
const STANDARD_FONTS_URL = "/pdfjs/standard_fonts/";
const PAGE_PADDING = 16; // .pdf-pages 좌우 패딩(px)과 일치시켜 fit 폭을 계산
// PDF는 zoom 1 = fit-to-width 다. 그보다 더 축소(페이지 전체/여러 페이지 개요)도
// 허용하기 위해 이미지 뷰어와 달리 하한을 1 미만으로 둔다.
const PDF_MIN_SCALE = 0.25;
// 핀치가 멈춘 뒤 실제 배율로 재래스터화하기까지의 지연(ms). 그동안은 CSS 프리뷰로
// 즉각 반응시킨다. 너무 짧으면 핀치 도중 무거운 렌더가 반복돼 버벅인다.
const RENDER_DEBOUNCE_MS = 120;

// 네이티브 iframe 대신 pdf.js로 캔버스 렌더링한다. 트랙패드 핀치(ctrl+휠)/터치 핀치로
// 확대·축소하면 해당 배율로 다시 렌더해 항상 선명하다. 패닝은 네이티브 스크롤.
export function PdfViewer({ path }: { path: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const firstPageWidthRef = useRef(0); // scale 1 에서의 첫 페이지 폭(px)
  const zoomRef = useRef(1); // fit 대비 배율(표시)
  const renderedZoomRef = useRef(1); // 현재 캔버스가 실제로 래스터화된 배율
  const renderTokenRef = useRef(0);
  const renderTasksRef = useRef<RenderTask[]>([]);

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
    // 이 렌더가 그려낼 배율을 캡처한다. 이후 핀치 프리뷰는 이 값 대비 현재 zoomRef
    // 비율로 캔버스 CSS 크기를 조절한다(재래스터화 없이 즉각 반응).
    const renderZoom = zoomRef.current;
    const effective = fitScale * renderZoom;
    renderedZoomRef.current = renderZoom;

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
      const cssW = viewport.width / dpr;
      const cssH = viewport.height / dpr;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      // 프리뷰 스케일의 기준이 되는 자연 CSS 크기(renderZoom 기준).
      canvas.dataset.cssw = String(cssW);
      canvas.dataset.cssh = String(cssH);

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
  }, []);

  // 재래스터화 없이 캔버스 CSS 크기만 현재 zoom 에 맞춘다(핀치 중 즉각 피드백).
  const applyPreview = useCallback(() => {
    const host = pagesRef.current;
    if (!host) return;
    const rendered = renderedZoomRef.current;
    const zoom = zoomRef.current;
    const canvases = host.querySelectorAll<HTMLCanvasElement>("canvas[data-cssw]");
    for (const canvas of canvases) {
      const w = Number(canvas.dataset.cssw);
      const h = Number(canvas.dataset.cssh);
      canvas.style.width = `${previewSize(w, zoom, rendered)}px`;
      canvas.style.height = `${previewSize(h, zoom, rendered)}px`;
    }
  }, []);

  // 문서 로드.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    firstPageWidthRef.current = 0;
    zoomRef.current = 1;
    renderedZoomRef.current = 1;
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

  // status/zoom 변화 시 다시 렌더. 핀치 중에는 CSS 프리뷰가 즉각 반응하므로,
  // 무거운 재래스터화는 제스처가 멈춘 뒤에만(디바운스) 한 번 수행한다.
  useEffect(() => {
    if (status !== "ready") return;
    const id = setTimeout(() => void renderAll(), RENDER_DEBOUNCE_MS);
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

  // 앵커(커서/핀치 중점) 아래 지점을 고정한 채 zoom 변경. 캔버스 CSS 크기를 즉시
  // 조절해 반응시키고(프리뷰), 선명한 재래스터화는 디바운스로 뒤따른다.
  const zoomAtPoint = useCallback(
    (factor: number, localX: number, localY: number) => {
      const scroll = scrollRef.current;
      const old = zoomRef.current;
      const next = clampScale(old * factor, PDF_MIN_SCALE, MAX_SCALE);
      if (next === old) return;
      zoomRef.current = next;
      // 1) 캔버스 크기를 즉시 키워/줄여 레이아웃 반영(스크롤 영역도 함께 갱신).
      applyPreview();
      // 2) 새 표시 크기 기준으로 앵커 지점이 고정되도록 스크롤 보정.
      if (scroll) {
        const s = anchoredScroll(scroll.scrollLeft, scroll.scrollTop, localX, localY, next / old);
        scroll.scrollLeft = s.left;
        scroll.scrollTop = s.top;
      }
      // 3) 컨트롤 표시 갱신 + 디바운스된 고품질 재렌더 트리거.
      setZoom(next);
    },
    [applyPreview],
  );

  useViewerGesture(scrollRef, { onZoom: zoomAtPoint });

  const zoomByButton = (factor: number) => {
    const el = scrollRef.current;
    zoomAtPoint(factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
  };

  const reset = () => {
    zoomRef.current = 1;
    applyPreview();
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
