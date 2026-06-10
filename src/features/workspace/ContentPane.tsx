import { useWorkspace } from "../../stores/workspace";
import { MarkdownEditor, SourceEditor } from "../editor/MarkdownEditor";

export function ContentPane() {
  const activePath = useWorkspace((s) => s.activePath);
  const tabs = useWorkspace((s) => s.tabs);
  const doc = useWorkspace((s) => (s.activePath ? s.docs[s.activePath] : undefined));
  const sourceMode = useWorkspace((s) => s.sourceMode);

  if (!activePath) {
    return (
      <div className="preview-placeholder">
        <p>왼쪽에서 파일을 선택하거나 새 노트를 만드세요</p>
      </div>
    );
  }

  if (!doc || doc.loading) {
    return (
      <div className="preview-placeholder">
        <p>불러오는 중…</p>
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
    return sourceMode ? (
      <SourceEditor key={`${activePath}:src`} path={activePath} />
    ) : (
      <MarkdownEditor key={`${activePath}:wysiwyg`} path={activePath} />
    );
  }

  // html/기타 파일은 M2(HTML 뷰어)까지 원문으로 표시
  return (
    <div className="preview">
      <div className="preview-path">{activePath}</div>
      <pre className="preview-content">{doc.content}</pre>
    </div>
  );
}
