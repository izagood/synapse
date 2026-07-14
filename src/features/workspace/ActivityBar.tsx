import { ipc } from "../../ipc/ipc";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import {
  FolderIcon,
  GearIcon,
  GraphIcon,
  HomeIcon,
  NewWindowIcon,
  SearchIcon,
  SearchTextIcon,
  SidebarIcon,
  TerminalIcon,
} from "../../shared/Icons";
import { shortcutLabel } from "../../shared/platform";
import { shortcutById } from "../../shared/shortcuts";
import { useT } from "../../i18n";

interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onQuickOpen: () => void;
  onSearch: () => void;
  onGraph: () => void;
  terminalVisible: boolean;
  onToggleTerminal: () => void;
}

// VS Code 액티비티 바: 상단 내비게이션 / 하단 폴더·설정
export function ActivityBar({
  sidebarVisible,
  onToggleSidebar,
  onQuickOpen,
  onSearch,
  onGraph,
  terminalVisible,
  onToggleTerminal,
}: ActivityBarProps) {
  const openFolder = useWorkspace((s) => s.openFolder);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const openSettings = useSettings((s) => s.openSettings);
  const quickOpenShortcut = shortcutLabel(shortcutById("nav.quickOpen").keys);
  const searchShortcut = shortcutLabel(shortcutById("nav.search").keys);
  const graphShortcut = shortcutLabel(shortcutById("view.graph").keys);
  const terminalShortcut = shortcutLabel(shortcutById("view.toggleTerminal").keys);
  const newWindowShortcut = shortcutLabel(shortcutById("window.new").keys);
  const settingsShortcut = shortcutLabel(shortcutById("settings.toggle").keys);
  const t = useT();

  return (
    <nav className="activity-bar">
      <div className="activity-top">
        <button
          className={sidebarVisible ? "active" : ""}
          onClick={onToggleSidebar}
          title={t("activity.toggleSidebar")}
        >
          <SidebarIcon size={18} />
        </button>
        <button onClick={onQuickOpen} title={t("activity.quickOpen", { shortcut: quickOpenShortcut })}>
          <SearchIcon size={18} />
        </button>
        <button onClick={onSearch} title={t("activity.search", { shortcut: searchShortcut })}>
          <SearchTextIcon size={18} />
        </button>
        <button onClick={onGraph} title={t("activity.graph", { shortcut: graphShortcut })}>
          <GraphIcon size={18} />
        </button>
        <button
          className={terminalVisible ? "active" : ""}
          onClick={onToggleTerminal}
          title={t("activity.terminal", { shortcut: terminalShortcut })}
        >
          <TerminalIcon size={18} />
        </button>
      </div>
      <div className="activity-bottom">
        <button
          onClick={() => void ipc.newWindow()}
          title={t("activity.newWindow", { shortcut: newWindowShortcut })}
        >
          <NewWindowIcon size={18} />
        </button>
        <button onClick={() => void openFolder()} title={t("activity.openAnotherFolder")}>
          <FolderIcon size={18} />
        </button>
        <button onClick={closeWorkspace} title={t("activity.backToStart")}>
          <HomeIcon size={18} />
        </button>
        <button onClick={openSettings} title={t("activity.settings", { shortcut: settingsShortcut })}>
          <GearIcon size={18} />
        </button>
      </div>
    </nav>
  );
}
