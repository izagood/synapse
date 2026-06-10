import { useWorkspace } from "../../stores/workspace";
import { FileTree } from "./FileTree";
import { FilePreview } from "./FilePreview";

export function WorkspaceView() {
  const root = useWorkspace((s) => s.root);
  const openFolder = useWorkspace((s) => s.openFolder);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const refreshTree = useWorkspace((s) => s.refreshTree);

  const folderName = root?.split("/").pop() || root;

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="topbar-title" title={root ?? ""}>
          {folderName}
        </span>
        <div className="topbar-actions">
          <button onClick={() => void refreshTree()} title="파일 트리 새로고침">
            ⟳
          </button>
          <button onClick={() => void openFolder()} title="다른 폴더 열기">
            폴더 열기
          </button>
          <button onClick={closeWorkspace} title="시작 화면으로">
            닫기
          </button>
        </div>
      </header>
      <div className="workspace-body">
        <aside className="sidebar">
          <FileTree />
        </aside>
        <main className="content">
          <FilePreview />
        </main>
      </div>
    </div>
  );
}
