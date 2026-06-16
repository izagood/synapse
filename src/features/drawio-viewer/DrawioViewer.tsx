import { useEffect, useState } from "react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { buildDrawioHtml } from "./buildDrawioHtml";

// 앱에 번들된(viewer-static.min.js) drawio 뷰어 런타임. Vite가 public/ 을 dist
// 루트로 복사하므로 앱 출처 기준 이 경로로 접근할 수 있다.
const VIEWER_ASSET_PATH = "vendor/drawio/viewer-static.min.js";
// 뷰어 JS를 쓰는 캐시 파일명 (모든 .drawio 노트가 공유한다)
const VIEWER_CACHE_NAME = "drawio-viewer.min.js";

function cacheNameFor(path: string): string {
  // 노트당 하나의 캐시 파일 (djb2 해시). HtmlViewer와 충돌하지 않도록 접두사를 둔다.
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return `drawio-${h.toString(16)}.html`;
}

// 3.8MB짜리 뷰어 런타임을 매번 캐시에 다시 쓰지 않도록, 세션당 한 번만 가져와
// 캐시에 쓰고 그 asset URL을 공유한다. 실패하면 다음 시도에서 다시 받게 비운다.
let viewerScriptUrl: Promise<string> | null = null;
function ensureViewerScript(): Promise<string> {
  if (!viewerScriptUrl) {
    viewerScriptUrl = fetch(new URL(VIEWER_ASSET_PATH, document.baseURI).href)
      .then((res) => {
        if (!res.ok) throw new Error(`drawio viewer ${res.status}`);
        return res.text();
      })
      .then((js) => ipc.prepareHtmlView(VIEWER_CACHE_NAME, js))
      .catch((e) => {
        viewerScriptUrl = null;
        throw e;
      });
  }
  return viewerScriptUrl;
}

// .drawio(mxGraph XML) 파일을 다이어그램으로 보여준다. HtmlViewer와 같은
// 격리 방식(캐시에 쓴 HTML을 sandbox iframe으로 로드)을 쓰고, 렌더링만 번들된
// drawio 뷰어 런타임에 맡긴다.
export function DrawioViewer({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const content = doc?.content ?? "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    ensureViewerScript()
      .then((scriptUrl) => ipc.prepareHtmlView(cacheNameFor(path), buildDrawioHtml(content, scriptUrl)))
      .then((url) => {
        if (!cancelled) setFrameSrc(url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [content, path]);

  if (error) {
    return (
      <div className="preview-placeholder">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!frameSrc) {
    return (
      <div className="preview-placeholder">
        <p>{t("viewer.preparing")}</p>
      </div>
    );
  }

  return (
    <iframe
      className="html-viewer"
      title={path}
      // 렌더링에 스크립트(뷰어 런타임)가 필요하다. 같은 출처/탑 네비게이션은 차단.
      sandbox="allow-scripts"
      src={frameSrc}
    />
  );
}
