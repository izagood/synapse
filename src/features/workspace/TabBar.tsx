import { useEffect, useRef, useState } from "react";
import { isDirty, useWorkspace } from "../../stores/workspace";
import { useAgent } from "../../stores/agent";
import { useHistoryUi } from "../history/historyStore";
import { CloseIcon, CodeIcon, GlobeIcon, PlusIcon } from "../../shared/Icons";
import { useT } from "../../i18n";

interface ContextMenuState {
  path: string;
  x: number;
  y: number;
}

// VS Code 스타일 탭 우클릭 메뉴
function TabContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState;
  onClose: () => void;
}) {
  const closeTab = useWorkspace((s) => s.closeTab);
  const closeOtherTabs = useWorkspace((s) => s.closeOtherTabs);
  const closeTabsToRight = useWorkspace((s) => s.closeTabsToRight);
  const closeAllTabs = useWorkspace((s) => s.closeAllTabs);
  const tabs = useWorkspace((s) => s.tabs);
  const openHistory = useHistoryUi((s) => s.open);
  const t = useT();

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [onClose]);

  const idx = tabs.findIndex((t) => t.path === menu.path);
  const run = (action: () => Promise<void>) => {
    onClose();
    void action();
  };

  return (
    <div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button onClick={() => run(() => closeTab(menu.path))}>{t("tabs.close")}</button>
      <button
        disabled={tabs.length <= 1}
        onClick={() => run(() => closeOtherTabs(menu.path))}
      >
        {t("tabs.closeOthers")}
      </button>
      <button
        disabled={idx === tabs.length - 1}
        onClick={() => run(() => closeTabsToRight(menu.path))}
      >
        {t("tabs.closeRight")}
      </button>
      <div className="context-sep" />
      <button onClick={() => run(closeAllTabs)}>{t("tabs.closeAll")}</button>
      <div className="context-sep" />
      <button
        onClick={() => {
          onClose();
          openHistory(menu.path);
        }}
      >
        {t("history.open")}
      </button>
    </div>
  );
}

export function TabBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activePath = useWorkspace((s) => s.activePath);
  const docs = useWorkspace((s) => s.docs);
  const sourceMode = useWorkspace((s) => s.sourceMode);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const closeTab = useWorkspace((s) => s.closeTab);
  const createNote = useWorkspace((s) => s.createNote);
  const toggleSourceMode = useWorkspace((s) => s.toggleSourceMode);
  const aiEditedPaths = useAgent((s) => s.aiEditedPaths);
  const exportNoteAsHtml = useWorkspace((s) => s.exportNoteAsHtml);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const activeTab = tabs.find((t) => t.path === activePath);

  // 활성 탭이 스크롤 영역 밖에 있으면 보이는 위치로 따라간다 (VS Code)
  useEffect(() => {
    tabsRef.current
      ?.querySelector(".tab.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activePath]);

  return (
    <div className="tab-bar" role="tablist">
      <div
        className="tabs"
        ref={tabsRef}
        onWheel={(e) => {
          // 세로 휠을 가로 스크롤로 변환 (스크롤바가 숨겨져 있어 마우스 사용자 배려)
          if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab) => {
          const dirty = isDirty(docs[tab.path]);
          const aiEdited = aiEditedPaths.includes(tab.path);
          return (
            <div
              key={tab.path}
              className={`tab${tab.path === activePath ? " active" : ""}${dirty ? " dirty" : ""}`}
              role="tab"
              aria-selected={tab.path === activePath}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ path: tab.path, x: e.clientX, y: e.clientY });
              }}
              onAuxClick={(e) => {
                // 휠 클릭으로 닫기 (VS Code)
                if (e.button === 1) void closeTab(tab.path);
              }}
            >
              <button
                className="tab-label"
                title={tab.path}
                onClick={() => setActiveTab(tab.path)}
              >
                {tab.name}
                {aiEdited && (
                  <span className="ai-edited-badge" title={t("agent.aiEditedBadge")}>
                    {t("agent.aiEditedBadge")}
                  </span>
                )}
              </button>
              <button
                className="tab-close"
                title={dirty ? t("tabs.closeAfterSave") : t("tabs.close")}
                onClick={() => void closeTab(tab.path)}
              >
                <span className="tab-dirty-dot" />
                <span className="tab-close-x">
                  <CloseIcon size={12} />
                </span>
              </button>
            </div>
          );
        })}
        <button className="tab-add" title={t("workspace.newNote")} onClick={() => void createNote()}>
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="tab-actions">
        {activeTab && activeTab.fileType === "markdown" && (
          <button
            onClick={() => void exportNoteAsHtml()}
            title={t("tabs.exportHtml")}
          >
            <GlobeIcon size={15} />
          </button>
        )}
        {activeTab && activeTab.fileType !== "other" && (
          <button
            className={sourceMode ? "active" : ""}
            onClick={toggleSourceMode}
            title={sourceMode ? t("tabs.switchToRendered") : t("tabs.switchToSource")}
          >
            <CodeIcon size={15} />
          </button>
        )}
      </div>
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
