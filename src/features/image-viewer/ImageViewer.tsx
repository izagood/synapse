import { useCallback, useRef, useState } from "react";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useT } from "../../i18n";
import { useViewerGesture } from "../viewer-zoom/useViewerGesture";
import { ZoomControls } from "../viewer-zoom/ZoomControls";
import {
  clampTranslate,
  IDENTITY,
  isZoomed,
  type Transform,
  zoomAt,
} from "../viewer-zoom/zoomMath";

// 이미지 파일 뷰어. 노트/HTML과 달리 바이너리이므로 텍스트로 읽지 않고,
// 로컬 절대 경로를 webview가 로드할 수 있는 asset URL로 변환해 <img>로 렌더링한다.
// 트랙패드 핀치(ctrl+휠) / 터치 핀치로 확대·축소하고, 확대 상태에서 드래그로 팬한다.
// 더블클릭은 "맞춤 ↔ 2배" 토글.
export function ImageViewer({ path }: { path: string }) {
  const [error, setError] = useState(false);
  const [t, setT] = useState<Transform>(IDENTITY);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const tr = useT();

  const viewport = useCallback(() => {
    const el = surfaceRef.current;
    return { vw: el?.clientWidth ?? 0, vh: el?.clientHeight ?? 0 };
  }, []);

  const applyZoom = useCallback(
    (factor: number, x: number, y: number) => {
      const { vw, vh } = viewport();
      setT((prev) => clampTranslate(zoomAt(prev, factor, x, y), vw, vh));
    },
    [viewport],
  );

  useViewerGesture(surfaceRef, {
    onZoom: applyZoom,
    onPan: (dx, dy) => {
      const { vw, vh } = viewport();
      setT((prev) =>
        clampTranslate({ scale: prev.scale, x: prev.x + dx, y: prev.y + dy }, vw, vh),
      );
    },
    panEnabled: () => isZoomed(t),
  });

  const reset = useCallback(() => setT(IDENTITY), []);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const el = surfaceRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { vw, vh } = viewport();
      setT((prev) =>
        isZoomed(prev) ? IDENTITY : clampTranslate(zoomAt(prev, 2, x, y), vw, vh),
      );
    },
    [viewport],
  );

  if (error) {
    return (
      <div className="preview-placeholder">
        <p className="error">{tr("viewer.imageError")}</p>
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      className={`image-viewer${isZoomed(t) ? " is-zoomed" : ""}`}
      onDoubleClick={onDoubleClick}
    >
      <div
        className="zoom-content"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
      >
        <img
          className="image-viewer-img"
          src={resolveAssetUrl(path)}
          alt={path}
          draggable={false}
          onError={() => setError(true)}
        />
      </div>
      <ZoomControls
        scale={t.scale}
        onZoomIn={() => applyZoom(1.4, viewport().vw / 2, viewport().vh / 2)}
        onZoomOut={() => applyZoom(1 / 1.4, viewport().vw / 2, viewport().vh / 2)}
        onReset={reset}
      />
    </div>
  );
}
