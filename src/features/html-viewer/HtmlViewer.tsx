import { useEffect, useState } from "react";
import { ipc } from "../../ipc/ipc";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
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
  const t = useT();

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

  // 뷰어 런타임이 보내는 외부 링크 열기 요청 처리
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; href?: string } | null;
      if (
        data?.type === "synapse:open-external" &&
        typeof data.href === "string" &&
        /^https?:\/\//i.test(data.href)
      ) {
        void ipc.openExternal(data.href);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
      // allow-scripts는 뷰어 런타임(# 앵커·외부 링크) 동작에 필요하다.
      // 기본 모드에서는 문서 자체 스크립트가 정화 단계에서 이미 제거되어
      // 우리 런타임만 실행된다. 같은 출처/탑 네비게이션은 항상 차단 (FR-3.2)
      sandbox="allow-scripts"
      src={frameSrc}
    />
  );
}
