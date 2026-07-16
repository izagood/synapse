import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { FileTree } from "./FileTree";
import { TabBar } from "./TabBar";
import { TitleBar } from "./TitleBar";
import { ContentPane } from "./ContentPane";
import { QuickOpenModal } from "./QuickOpenModal";
import { SearchModal } from "./SearchModal";
import { ActivityBar } from "./ActivityBar";
import { CreateMenu } from "./CreateMenu";
import { createTargetDir } from "./fileTreeUtils";
import { SyncBar } from "../sync/SyncBar";
import { TerminalDock } from "../terminal/TerminalDock";
import { useTerminal } from "../../stores/terminal";
import { GraphView } from "../graph/GraphView";
import { FileHistoryModal } from "../history/FileHistoryModal";
import { useHistoryUi } from "../history/historyStore";
import { GlobeIcon, PlusIcon, RefreshIcon } from "../../shared/Icons";
import { basename } from "../../shared/pathUtils";
import { registerCommand } from "../commands/registry";
import { CommandPalette } from "../commands/CommandPalette";
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const [graph, setGraph] = useState(false);
  const [palette, setPalette] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const terminalVisible = useTerminal((s) => s.visible);
  const toggleTerminal = useTerminal((s) => s.toggle);
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

  // 컴포넌트 로컬 state 에 묶인 커맨드 — 마운트 동안만 동적 등록 (VS Code 방식).
  // 스토어 기반 커맨드(탭 닫기류·저장·새 파일 등)는 staticCommands 에서 정적 등록된다.
  useEffect(() => {
    const offs = [
      registerCommand({
        id: "view.graph",
        titleKey: "shortcuts.desc.graph",
        category: "view",
        run: () => setGraph((v) => !v),
      }),
      registerCommand({
        id: "nav.search",
        titleKey: "shortcuts.desc.search",
        category: "navigation",
        run: () => setSearch((v) => !v),
      }),
      registerCommand({
        id: "nav.quickOpen",
        titleKey: "shortcuts.desc.quickOpen",
        category: "navigation",
        run: () => setQuickOpen((v) => !v),
      }),
      registerCommand({
        id: "view.toggleSidebar",
        titleKey: "shortcuts.desc.toggleSidebar",
        category: "view",
        run: () => setSidebarVisible((v) => !v),
      }),
      registerCommand({
        id: "palette.toggle",
        titleKey: "shortcuts.desc.palette",
        category: "general",
        hideFromPalette: true, // 팔레트 안에서 "팔레트 열기"는 무의미
        run: () => setPalette((v) => !v),
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

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
      <TitleBar title={folderName ?? ""} onOpenPalette={() => setPalette(true)} />
      <div className="workspace-body">
        <ActivityBar
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          onQuickOpen={() => setQuickOpen(true)}
          onSearch={() => setSearch(true)}
          onGraph={() => setGraph(true)}
          terminalVisible={terminalVisible}
          onToggleTerminal={toggleTerminal}
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
          {/* 항상 마운트(터미널 있으면). 숨김은 Dock 내부에서 CSS로 처리 → 토글해도 세션 유지 */}
          <TerminalDock />
        </main>
      </div>
      <SyncBar />
      {quickOpen && <QuickOpenModal onClose={() => setQuickOpen(false)} />}
      {search && <SearchModal onClose={() => setSearch(false)} />}
      {graph && <GraphView onClose={() => setGraph(false)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
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
