import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useT } from "../../i18n";
import { useViewerGesture } from "../viewer-zoom/useViewerGesture";
import { ZoomControls } from "../viewer-zoom/ZoomControls";
import { anchoredScroll, clampScale, MAX_SCALE, previewSize } from "../viewer-zoom/zoomMath";
import { usePdfDraw } from "../pdf-draw/usePdfDraw";
import { redrawOverlay } from "../pdf-draw/renderStrokes";
import { newShapeId, shapesOnPage, type PathShape, type Shape } from "../pdf-draw/drawDoc";
import { PdfDrawToolbar } from "../pdf-draw/PdfDrawToolbar";
import { PdfDrawMenu } from "../pdf-draw/PdfDrawMenu";

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
const ERASER_SCREEN_PX = 10; // 지우개 반경(화면 px)
const MIN_POINT_SCREEN_PX = 2; // 점 추가 최소 이동(화면 px) — 좌표 수 절약

// 네이티브 iframe 대신 pdf.js로 캔버스 렌더링한다. 트랙패드 핀치(ctrl+휠)/터치 핀치로
// 확대·축소하면 해당 배율로 다시 렌더해 항상 선명하다. 패닝은 네이티브 스크롤.
// 각 페이지 위에 투명한 오버레이 캔버스를 얹어 자유곡선 드로잉을 그린다.
export function PdfViewer({ path }: { path: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const firstPageWidthRef = useRef(0); // scale 1 에서의 첫 페이지 폭(px)
  const zoomRef = useRef(1); // fit 대비 배율(표시)
  const renderedZoomRef = useRef(1); // 현재 캔버스가 실제로 래스터화된 배율
  const fitScaleRef = useRef(1); // 현재 fit 배율(컨테이너 폭/첫 페이지 폭)
  const dprRef = useRef(1);
  const renderTokenRef = useRef(0);
  const renderTasksRef = useRef<RenderTask[]>([]);

  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [menu, setMenu] = useState<{ x: number; y: number; page: number | null } | null>(null);
  const t = useT();

  const draw = usePdfDraw(path);
  // 포인터 핸들러가 최신 도구/색/굵기를 동기적으로 읽도록 ref 로도 보관.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // 한 페이지의 오버레이를 "래스터화된" 배율로 다시 그린다(진행 중 획 extra 포함).
  // 오버레이 백킹스토어는 pdf 캔버스와 같은 배율(fit*renderedZoom)이고, 프리뷰 중에는
  // pdf 캔버스와 함께 CSS 로만 확대/축소되므로 표시 배율과 무관하게 이 값으로 그린다.
  const redrawPage = useCallback((page: number, extra?: Shape | null) => {
    const host = pagesRef.current;
    if (!host) return;
    const overlay = host.querySelector<HTMLCanvasElement>(
      `.pdf-page-wrap[data-page="${page}"] .pdf-draw`,
    );
    if (!overlay) return;
    const doc = drawRef.current.docRef.current;
    if (!doc) return;
    const scale = fitScaleRef.current * renderedZoomRef.current;
    redrawOverlay(overlay, shapesOnPage(doc, page), scale, dprRef.current, extra);
  }, []);

  const redrawAllOverlays = useCallback(() => {
    const host = pagesRef.current;
    if (!host) return;
    host.querySelectorAll<HTMLElement>(".pdf-page-wrap").forEach((wrap) => {
      redrawPage(Number(wrap.dataset.page));
    });
  }, [redrawPage]);

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
    fitScaleRef.current = fitScale;
    dprRef.current = dpr;

    for (let i = 1; i <= doc.numPages; i++) {
      if (token !== renderTokenRef.current) return; // 더 새 렌더로 교체됨
      const page = await doc.getPage(i);
      if (token !== renderTokenRef.current) return;
      const viewport = page.getViewport({ scale: effective * dpr });

      // 페이지마다 래퍼(pdf 캔버스 + 오버레이 캔버스)를 둔다.
      let wrap = host.querySelector<HTMLDivElement>(`.pdf-page-wrap[data-page="${i}"]`);
      if (!wrap) {
        wrap = document.createElement("div");
        wrap.className = "pdf-page-wrap";
        wrap.dataset.page = String(i);
        const pdfCanvas = document.createElement("canvas");
        pdfCanvas.className = "pdf-page";
        const overlay = document.createElement("canvas");
        overlay.className = "pdf-draw";
        wrap.append(pdfCanvas, overlay);
        host.appendChild(wrap);
      }
      const canvas = wrap.querySelector<HTMLCanvasElement>(".pdf-page")!;
      const overlay = wrap.querySelector<HTMLCanvasElement>(".pdf-draw")!;

      const cssW = viewport.width / dpr;
      const cssH = viewport.height / dpr;
      // 프리뷰 스케일의 기준이 되는 자연 CSS 크기(renderZoom 기준).
      wrap.dataset.cssw = String(cssW);
      wrap.dataset.cssh = String(cssH);
      wrap.style.width = `${cssW}px`;
      wrap.style.height = `${cssH}px`;
      for (const c of [canvas, overlay]) {
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const task = page.render({ canvasContext: ctx, viewport });
      renderTasksRef.current.push(task);
      try {
        await task.promise;
      } catch {
        // 취소된 렌더(RenderingCancelledException)는 무시한다.
      }
      // pdf 렌더 후 그 페이지의 드로잉을 다시 얹는다.
      redrawPage(i);
    }
  }, [redrawPage]);

  // 재래스터화 없이 래퍼/캔버스 CSS 크기만 현재 zoom 에 맞춘다(핀치 중 즉각 피드백).
  const applyPreview = useCallback(() => {
    const host = pagesRef.current;
    if (!host) return;
    const rendered = renderedZoomRef.current;
    const z = zoomRef.current;
    host.querySelectorAll<HTMLElement>(".pdf-page-wrap[data-cssw]").forEach((wrap) => {
      const w = previewSize(Number(wrap.dataset.cssw), z, rendered);
      const h = previewSize(Number(wrap.dataset.cssh), z, rendered);
      wrap.style.width = `${w}px`;
      wrap.style.height = `${h}px`;
      wrap.querySelectorAll<HTMLCanvasElement>("canvas").forEach((c) => {
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      });
    });
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

  // 사이드카 로드/undo/clear 등으로 도형 수가 바뀌면 오버레이를 다시 그린다.
  useEffect(() => {
    if (status === "ready") redrawAllOverlays();
  }, [status, draw.shapeCount, redrawAllOverlays]);

  // ---- 포인터 드로잉/지우개 ----
  useEffect(() => {
    const host = pagesRef.current;
    if (!host) return;

    let curShape: PathShape | null = null;
    let curPage = 0;
    let curOverlay: HTMLCanvasElement | null = null;
    let activeId: number | null = null;

    // 이벤트 → (페이지, scale1 좌표). 표시 배율(fit*zoom) 기준으로 역산하므로
    // 핀치 프리뷰 중(렌더 배율과 표시 배율이 다른 동안)에도 정확하다.
    const locate = (e: PointerEvent) => {
      const wrap = (e.target as HTMLElement).closest<HTMLDivElement>(".pdf-page-wrap");
      if (!wrap) return null;
      const overlay = wrap.querySelector<HTMLCanvasElement>(".pdf-draw");
      if (!overlay) return null;
      const rect = overlay.getBoundingClientRect();
      const s = fitScaleRef.current * zoomRef.current || 1;
      return {
        page: Number(wrap.dataset.page),
        overlay,
        x: (e.clientX - rect.left) / s,
        y: (e.clientY - rect.top) / s,
      };
    };

    const eraserRadius = () => ERASER_SCREEN_PX / (fitScaleRef.current * zoomRef.current || 1);

    const onDown = (e: PointerEvent) => {
      const api = drawRef.current;
      if (!api.isDrawing || e.button !== 0) return;
      const hit = locate(e);
      if (!hit) return;
      e.preventDefault();
      activeId = e.pointerId;
      curOverlay = hit.overlay;
      curPage = hit.page;
      hit.overlay.setPointerCapture?.(e.pointerId);

      if (api.tool === "eraser") {
        curShape = null;
        if (api.eraseAt(hit.page, hit.x, hit.y, eraserRadius())) redrawPage(hit.page);
        return;
      }
      curShape = {
        id: newShapeId(),
        type: "path",
        tool: api.tool === "highlighter" ? "highlighter" : "pen",
        color: api.color,
        width: api.effectiveWidth(),
        opacity: api.opacity,
        points: [hit.x, hit.y],
      };
      redrawPage(hit.page, curShape);
    };

    const onMove = (e: PointerEvent) => {
      if (activeId !== e.pointerId) return;
      const api = drawRef.current;
      const hit = locate(e);
      if (!hit) return;

      if (api.tool === "eraser") {
        if (api.eraseAt(hit.page, hit.x, hit.y, eraserRadius())) redrawPage(hit.page);
        return;
      }
      if (!curShape) return;
      e.preventDefault();
      const pts = curShape.points;
      const minD = MIN_POINT_SCREEN_PX / (fitScaleRef.current * zoomRef.current || 1);
      if (Math.hypot(hit.x - pts[pts.length - 2], hit.y - pts[pts.length - 1]) >= minD) {
        pts.push(hit.x, hit.y);
        redrawPage(curPage, curShape);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (activeId !== e.pointerId) return;
      curOverlay?.releasePointerCapture?.(e.pointerId);
      activeId = null;
      if (curShape) {
        drawRef.current.commitShape(curPage, curShape);
        curShape = null;
      }
      curOverlay = null;
    };

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
    };
  }, [redrawPage]);

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

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const wrap = (e.target as HTMLElement).closest<HTMLDivElement>(".pdf-page-wrap");
    setMenu({ x: e.clientX, y: e.clientY, page: wrap ? Number(wrap.dataset.page) : null });
  };

  return (
    <div
      className={`pdf-viewer${draw.isDrawing ? " drawing" : ""}`}
      onContextMenu={status === "ready" ? openMenu : undefined}
    >
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
        <>
          <PdfDrawToolbar draw={draw} />
          <ZoomControls
            scale={zoom}
            onZoomIn={() => zoomByButton(1.4)}
            onZoomOut={() => zoomByButton(1 / 1.4)}
            onReset={reset}
          />
        </>
      )}
      {menu && (
        <PdfDrawMenu
          x={menu.x}
          y={menu.y}
          page={menu.page}
          path={path}
          draw={draw}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
