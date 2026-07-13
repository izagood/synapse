import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import { FileTree } from "./FileTree";
import { TabBar } from "./TabBar";
import { ContentPane } from "./ContentPane";
import { QuickOpenModal } from "./QuickOpenModal";
import { SearchModal } from "./SearchModal";
import { ActivityBar } from "./ActivityBar";
import { CreateMenu } from "./CreateMenu";
import { createTargetDir } from "./fileTreeUtils";
import { SyncBar } from "../sync/SyncBar";
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

function loadSidebarWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_KEY));
  return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
}

export function WorkspaceView() {
  const root = useWorkspace((s) => s.root);
  const error = useWorkspace((s) => s.error);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const createNote = useWorkspace((s) => s.createNote);
  const createFolder = useWorkspace((s) => s.createFolder);
  const createDrawing = useWorkspace((s) => s.createDrawing);
  const createDrawioFile = useWorkspace((s) => s.createDrawioFile);
  const importHtmlAsNote = useWorkspace((s) => s.importHtmlAsNote);
  const saveActive = useWorkspace((s) => s.saveActive);
  const [quickOpen, setQuickOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const [graph, setGraph] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const historyPath = useHistoryUi((s) => s.path);
  const closeHistory = useHistoryUi((s) => s.close);
  const dragging = useRef(false);
  // + 버튼에서 여는 "새로 만들기" 메뉴의 기준 좌표 (null이면 닫힘)
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const t = useT();

  // 새 항목을 만들 대상 폴더: 현재 열린 파일이 든 폴더, 없으면 루트.
  // store에서 직접 읽어 키다운/클릭 시점의 최신 선택을 반영한다.
  const targetDir = useCallback(() => {
    const { activePath, root: r } = useWorkspace.getState();
    return createTargetDir(activePath, r ?? "");
  }, []);

  // + 버튼 클릭 → 버튼 바로 아래에 메뉴를 띄운다(다시 누르면 토글로 닫힘)
  const toggleCreateMenu = useCallback(() => {
    setCreateMenu((cur) => {
      if (cur) return null;
      const r = plusBtnRef.current?.getBoundingClientRect();
      return r ? { x: r.left, y: r.bottom + 4 } : { x: 0, y: 0 };
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
      if (isShortcut(e, "view.graph")) {
        e.preventDefault();
        setGraph((v) => !v);
      } else if (isShortcut(e, "nav.search")) {
        e.preventDefault();
        setSearch((v) => !v);
      } else if (isShortcut(e, "file.newNote")) {
        e.preventDefault();
        void createNote(targetDir());
      } else if (isShortcut(e, "file.newDrawing")) {
        e.preventDefault();
        void createDrawing(targetDir());
      } else if (isShortcut(e, "file.newDiagram")) {
        e.preventDefault();
        void createDrawioFile(targetDir());
      } else if (isShortcut(e, "file.save")) {
        e.preventDefault();
        void saveActive();
      } else if (isShortcut(e, "nav.quickOpen")) {
        e.preventDefault();
        setQuickOpen((v) => !v);
      } else if (isShortcut(e, "view.toggleSidebar")) {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      } else if (isShortcut(e, "view.toggleTerminal")) {
        e.preventDefault();
        const { root: r } = useWorkspace.getState();
        if (r) void ipc.openExternalTerminal(r).catch(() => undefined);
      } else if (isShortcut(e, "tab.close")) {
        // 현재 노트 탭을 닫는다. 탭이 없으면 가로채지 않고 OS 기본
        // 동작(창/앱 닫기)에 맡겨, 마지막 노트까지 닫혔을 때만 앱이 닫힌다.
        const { activePath, closeTab } = useWorkspace.getState();
        if (activePath) {
          e.preventDefault();
          void closeTab(activePath);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive, createNote, createDrawing, createDrawioFile, targetDir]);

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
        />
        {sidebarVisible && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <div className="sidebar-header">
                <span className="sidebar-title" title={root ?? ""}>
                  {folderName}
                </span>
                <span className="sidebar-actions">
                  <button
                    ref={plusBtnRef}
                    onClick={toggleCreateMenu}
                    title={t("workspace.newItem")}
                  >
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
      </div>
      <SyncBar />
      {quickOpen && <QuickOpenModal onClose={() => setQuickOpen(false)} />}
      {search && <SearchModal onClose={() => setSearch(false)} />}
      {graph && <GraphView onClose={() => setGraph(false)} />}
      {historyPath && (
        <FileHistoryModal key={historyPath} path={historyPath} onClose={closeHistory} />
      )}
      {createMenu && (
        <CreateMenu
          anchor={createMenu}
          onNote={() => void createNote(targetDir())}
          onFolder={() => void createFolder(targetDir())}
          onDrawing={() => void createDrawing(targetDir())}
          onDiagram={() => void createDrawioFile(targetDir())}
          onClose={() => setCreateMenu(null)}
        />
      )}
    </div>
  );
}
