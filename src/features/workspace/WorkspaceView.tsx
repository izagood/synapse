import { useEffect } from "react";
import { useWorkspace } from "../../stores/workspace";
import { FileTree } from "./FileTree";
import { TabBar } from "./TabBar";
import { ContentPane } from "./ContentPane";
import { SyncBar } from "../sync/SyncBar";

export function WorkspaceView() {
  const root = useWorkspace((s) => s.root);
  const sourceMode = useWorkspace((s) => s.sourceMode);
  const activeTab = useWorkspace((s) =>
    s.tabs.find((t) => t.path === s.activePath),
  );
  const error = useWorkspace((s) => s.error);
  const openFolder = useWorkspace((s) => s.openFolder);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const createNote = useWorkspace((s) => s.createNote);
  const saveActive = useWorkspace((s) => s.saveActive);
  const toggleSourceMode = useWorkspace((s) => s.toggleSourceMode);

  // Ctrl/Cmd+S: 즉시 저장 (FR-2.6)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive]);

  const folderName = root?.split("/").pop() || root;

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="topbar-title" title={root ?? ""}>
          {folderName}
        </span>
        <div className="topbar-actions">
          <button onClick={() => void createNote()} title="새 노트 만들기">
            ＋ 새 노트
          </button>
          {activeTab && activeTab.fileType !== "other" && (
            <button onClick={toggleSourceMode} title="렌더 ↔ 소스 전환">
              {sourceMode
                ? activeTab.fileType === "markdown"
                  ? "편집 모드"
                  : "렌더 보기"
                : "소스 모드"}
            </button>
          )}
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
      {error && <div className="workspace-error error">{error}</div>}
      <div className="workspace-body">
        <aside className="sidebar">
          <FileTree />
        </aside>
        <main className="content">
          <TabBar />
          <div className="content-pane">
            <ContentPane />
          </div>
        </main>
      </div>
      <SyncBar />
    </div>
  );
}
