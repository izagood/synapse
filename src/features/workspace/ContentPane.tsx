import { lazy, Suspense } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { MarkdownEditor, SourceEditor } from "../editor/MarkdownEditor";
import { HtmlViewer } from "../html-viewer/HtmlViewer";
import { PdfViewer } from "../pdf-viewer/PdfViewer";
import { ImageViewer } from "../image-viewer/ImageViewer";
import { DrawioPane } from "../drawio-viewer/DrawioPane";
import { BacklinksPanel } from "./BacklinksPanel";

// Excalidraw 번들은 무거우므로(수 MB) 드로잉을 열 때만 동적으로 불러온다.
const ExcalidrawEditor = lazy(() => import("../excalidraw/ExcalidrawEditor"));

export function ContentPane() {
  const activePath = useWorkspace((s) => s.activePath);
  const tabs = useWorkspace((s) => s.tabs);
  const doc = useWorkspace((s) => (s.activePath ? s.docs[s.activePath] : undefined));
  const sourceMode = useWorkspace((s) => s.sourceMode);
  const t = useT();

  if (!activePath) {
    return (
      <div className="preview-placeholder">
        <p>{t("workspace.empty")}</p>
      </div>
    );
  }

  if (!doc || doc.loading) {
    return (
      <div className="preview-placeholder">
        <p>{t("common.loading")}</p>
      </div>
    );
  }

  if (doc.error && doc.content === "" && doc.savedContent === "") {
    return (
      <div className="preview-placeholder">
        <p className="error">{doc.error}</p>
      </div>
    );
  }

  const tab = tabs.find((t) => t.path === activePath);

  if (tab?.fileType === "markdown") {
    // key에 모드를 포함해 모드 전환 시 현재 content 기준으로 리마운트
    return (
      <div className="editor-with-backlinks">
        {sourceMode ? (
          <SourceEditor key={`${activePath}:src`} path={activePath} />
        ) : (
          <MarkdownEditor key={`${activePath}:wysiwyg`} path={activePath} />
        )}
        <BacklinksPanel />
      </div>
    );
  }

  if (tab?.fileType === "html" && !sourceMode) {
    return <HtmlViewer key={activePath} path={activePath} />;
  }

  if (tab?.fileType === "pdf") {
    return <PdfViewer key={activePath} path={activePath} />;
  }

  if (tab?.fileType === "image") {
    return <ImageViewer key={activePath} path={activePath} />;
  }

  if (tab?.fileType === "drawio" && !sourceMode) {
    return <DrawioPane key={activePath} path={activePath} />;
  }

  if (tab?.fileType === "excalidraw") {
    // externalRev를 key에 넣어 외부 변경(원격 머지 등) 시에만 초기 장면을 새로 읽는다.
    return (
      <Suspense
        fallback={
          <div className="preview-placeholder">
            <p>{t("common.loading")}</p>
          </div>
        }
      >
        <ExcalidrawEditor key={`${activePath}:${doc.externalRev}`} path={activePath} />
      </Suspense>
    );
  }

  // html/drawio 소스 보기 및 기타 파일은 원문으로 표시
  return (
    <div className="preview">
      <div className="preview-path">{activePath}</div>
      <pre className="preview-content">{doc.content}</pre>
    </div>
  );
}
