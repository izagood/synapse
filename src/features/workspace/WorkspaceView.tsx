import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { FileTree } from "./FileTree";
import { TabBar } from "./TabBar";
import { ContentPane } from "./ContentPane";
import { QuickOpenModal } from "./QuickOpenModal";
import { SearchModal } from "./SearchModal";
import { ActivityBar } from "./ActivityBar";
import { SyncBar } from "../sync/SyncBar";
import { AgentPanel } from "../agent/AgentPanel";
import { GraphView } from "../graph/GraphView";
import { FileHistoryModal } from "../history/FileHistoryModal";
import { useHistoryUi } from "../history/historyStore";
import { GlobeIcon, PlusIcon, RefreshIcon } from "../../shared/Icons";
import { basename } from "../../shared/pathUtils";
import { isShortcut } from "../../shared/shortcuts";
import { useT } from "../../i18n";

const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SIDEBAR_KEY = "synapse.sidebarWidth";
const AGENT_PANEL_KEY = "synapse.agentPanelVisible";

function loadSidebarWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_KEY));
  return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
}

export function WorkspaceView() {
  const root = useWorkspace((s) => s.root);
  const error = useWorkspace((s) => s.error);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const createNote = useWorkspace((s) => s.createNote);
  const importHtmlAsNote = useWorkspace((s) => s.importHtmlAsNote);
  const saveActive = useWorkspace((s) => s.saveActive);
  const [quickOpen, setQuickOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const [graph, setGraph] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [agentVisible, setAgentVisible] = useState(
    () => localStorage.getItem(AGENT_PANEL_KEY) === "1",
  );
  const historyPath = useHistoryUi((s) => s.path);
  const closeHistory = useHistoryUi((s) => s.close);
  const dragging = useRef(false);
  const t = useT();

  const toggleAgent = useCallback(() => {
    setAgentVisible((v) => {
      localStorage.setItem(AGENT_PANEL_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // 클립보드의 HTML(AI 산출물 등)을 정화·변환해 새 노트로 가져온다 (FR-3.4).
  const importHtmlFromClipboard = useCallback(async () => {
    const html = await navigator.clipboard?.readText?.();
    if (html && html.trim()) await importHtmlAsNote(html);
  }, [importHtmlAsNote]);

  // 워크스페이스 단축키 (VS Code 관례) — 정의는 shared/shortcuts 단일 출처
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isShortcut(e, "view.toggleAgent")) {
        e.preventDefault();
        toggleAgent();
      } else if (isShortcut(e, "view.graph")) {
        e.preventDefault();
        setGraph((v) => !v);
      } else if (isShortcut(e, "nav.search")) {
        e.preventDefault();
        setSearch((v) => !v);
      } else if (isShortcut(e, "file.save")) {
        e.preventDefault();
        void saveActive();
      } else if (isShortcut(e, "nav.quickOpen")) {
        e.preventDefault();
        setQuickOpen((v) => !v);
      } else if (isShortcut(e, "view.toggleSidebar")) {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive, toggleAgent]);

  // 사이드바 드래그 리사이즈 (F1) — 더블클릭으로 기본값 복원
  const onHandleDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // 드래그 중 파일 트리 등의 텍스트가 선택되는 것을 막는다
    document.body.classList.add("resizing-sidebar");
  }, []);

  const onHandleMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    // 액티비티 바(48px)를 뺀 위치가 사이드바 너비
    const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - 48));
    setSidebarWidth(width);
  }, []);

  const onHandleUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove("resizing-sidebar");
    setSidebarWidth((w) => {
      localStorage.setItem(SIDEBAR_KEY, String(w));
      return w;
    });
  }, []);

  const resetSidebar = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
    localStorage.setItem(SIDEBAR_KEY, String(SIDEBAR_DEFAULT));
  }, []);

  // 드래그 도중 핸들이 언마운트(예: Ctrl+B로 사이드바 숨김)되어도 클래스가 남지 않도록 정리
  useEffect(
    () => () => {
      document.body.classList.remove("resizing-sidebar");
    },
    [],
  );

  const folderName = root ? basename(root) : root;

  return (
    <div className="workspace">
      <div className="workspace-body">
        <ActivityBar
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          onQuickOpen={() => setQuickOpen(true)}
          onSearch={() => setSearch(true)}
          onGraph={() => setGraph(true)}
          agentVisible={agentVisible}
          onToggleAgent={toggleAgent}
        />
        {sidebarVisible && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <div className="sidebar-header">
                <span className="sidebar-title" title={root ?? ""}>
                  {folderName}
                </span>
                <span className="sidebar-actions">
                  <button onClick={() => void createNote()} title={t("workspace.newNote")}>
                    <PlusIcon size={15} />
                  </button>
                  <button
                    onClick={() => void importHtmlFromClipboard()}
                    title={t("workspace.importHtml")}
                  >
                    <GlobeIcon size={14} />
                  </button>
                  <button onClick={() => void refreshTree()} title={t("workspace.refreshTree")}>
                    <RefreshIcon size={14} />
                  </button>
                </span>
              </div>
              <FileTree />
            </aside>
            <div
              className="sidebar-resize-handle"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onDoubleClick={resetSidebar}
            />
          </>
        )}
        <main className="content">
          <TabBar />
          {error && <div className="workspace-error error">{error}</div>}
          <div className="content-pane">
            <ContentPane />
          </div>
        </main>
        {agentVisible && <AgentPanel onClose={toggleAgent} />}
      </div>
      <SyncBar />
      {quickOpen && <QuickOpenModal onClose={() => setQuickOpen(false)} />}
      {search && <SearchModal onClose={() => setSearch(false)} />}
      {graph && <GraphView onClose={() => setGraph(false)} />}
      {historyPath && (
        <FileHistoryModal key={historyPath} path={historyPath} onClose={closeHistory} />
      )}
    </div>
  );
}
