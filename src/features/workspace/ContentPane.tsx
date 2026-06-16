import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { MarkdownEditor, SourceEditor } from "../editor/MarkdownEditor";
import { HtmlViewer } from "../html-viewer/HtmlViewer";
import { PdfViewer } from "../pdf-viewer/PdfViewer";
import { ImageViewer } from "../image-viewer/ImageViewer";
import { DrawioViewer } from "../drawio-viewer/DrawioViewer";
import { BacklinksPanel } from "./BacklinksPanel";

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
    return <DrawioViewer key={activePath} path={activePath} />;
  }

  // html/drawio 소스 보기 및 기타 파일은 원문으로 표시
  return (
    <div className="preview">
      <div className="preview-path">{activePath}</div>
      <pre className="preview-content">{doc.content}</pre>
    </div>
  );
}
