import { useT } from "../../i18n";
import { MAX_SCALE, MIN_SCALE } from "./zoomMath";

// 마우스 사용자(핀치 불가)와 접근성을 위한 줌 컨트롤 오버레이.
// 이미지/PDF 뷰어가 공유한다. 가운데 버튼(현재 배율)을 누르면 맞춤으로 리셋.
export function ZoomControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div className="viewer-zoom-controls">
      <button
        type="button"
        title={t("viewer.zoomOut")}
        aria-label={t("viewer.zoomOut")}
        onClick={onZoomOut}
        disabled={scale <= MIN_SCALE}
      >
        −
      </button>
      <button
        type="button"
        className="viewer-zoom-level"
        title={t("viewer.zoomFit")}
        aria-label={t("viewer.zoomFit")}
        onClick={onReset}
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        title={t("viewer.zoomIn")}
        aria-label={t("viewer.zoomIn")}
        onClick={onZoomIn}
        disabled={scale >= MAX_SCALE}
      >
        +
      </button>
    </div>
  );
}
