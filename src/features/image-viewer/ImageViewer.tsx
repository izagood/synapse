import { useState } from "react";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useT } from "../../i18n";

// 이미지 파일 뷰어. 노트/HTML과 달리 바이너리이므로 텍스트로 읽지 않고,
// 로컬 절대 경로를 webview가 로드할 수 있는 asset URL로 변환해 <img>로 렌더링한다.
// 클릭하면 "화면 맞춤 ↔ 실제 크기"를 토글한다.
export function ImageViewer({ path }: { path: string }) {
  const [error, setError] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const t = useT();

  if (error) {
    return (
      <div className="preview-placeholder">
        <p className="error">{t("viewer.imageError")}</p>
      </div>
    );
  }

  return (
    <div className={`image-viewer${actualSize ? " is-actual" : ""}`}>
      <img
        className="image-viewer-img"
        src={resolveAssetUrl(path)}
        alt={path}
        title={actualSize ? t("viewer.zoomToFit") : t("viewer.zoomToActual")}
        onClick={() => setActualSize((v) => !v)}
        onError={() => setError(true)}
      />
    </div>
  );
}
