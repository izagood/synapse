import { useEffect, useState } from "react";
import { ipc, resolveAssetUrl } from "../../ipc/ipc";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { buildViewerHtml } from "./buildViewerHtml";

function cacheNameFor(path: string): string {
  // 노트당 하나의 캐시 파일 (djb2 해시)
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return `${h.toString(16)}.html`;
}

// 정화(또는 스크립트 허용 시 원문) HTML을 캐시 파일로 쓰고 실제 URL로 렌더링한다.
// srcdoc 대신 실제 URL을 쓰는 이유: #앵커 이동이 네이티브로 동작하고,
// 부모 CSP를 상속받지 않아 "스크립트 허용" 설정이 실제로 동작한다 (FR-3).
export function HtmlViewer({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const viewerSettings = useSettings((s) => s.settings.htmlViewer);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const baseDir = path.slice(0, path.lastIndexOf("/"));
  const content = doc?.content ?? "";

  useEffect(() => {
    let cancelled = false;
    const html = buildViewerHtml(content, {
      baseUrl: resolveAssetUrl(baseDir),
      resolveLocal: (rel) => resolveAssetUrl(`${baseDir}/${rel.replace(/^\.\//, "")}`),
      allowScripts: viewerSettings.allowScripts,
      allowNetwork: viewerSettings.allowNetwork,
    });
    ipc
      .prepareHtmlView(cacheNameFor(path), html)
      .then((url) => {
        if (!cancelled) setFrameSrc(url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [content, baseDir, path, viewerSettings.allowScripts, viewerSettings.allowNetwork]);

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
        <p>렌더링 준비 중…</p>
      </div>
    );
  }

  return (
    <iframe
      className="html-viewer"
      title={path}
      // 스크립트는 설정에서 명시적으로 허용했을 때만. 같은 출처/탑 네비게이션은 항상 차단 (FR-3.2)
      sandbox={viewerSettings.allowScripts ? "allow-scripts" : ""}
      src={frameSrc}
    />
  );
}
