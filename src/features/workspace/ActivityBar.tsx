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
  SparkleIcon,
} from "../../shared/Icons";
import { shortcutLabel } from "../../shared/platform";
import { useT } from "../../i18n";

interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onQuickOpen: () => void;
  onSearch: () => void;
  onGraph: () => void;
  agentVisible: boolean;
  onToggleAgent: () => void;
}

// VS Code 액티비티 바: 상단 내비게이션 / 하단 폴더·설정
export function ActivityBar({
  sidebarVisible,
  onToggleSidebar,
  onQuickOpen,
  onSearch,
  onGraph,
  agentVisible,
  onToggleAgent,
}: ActivityBarProps) {
  const openFolder = useWorkspace((s) => s.openFolder);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const openSettings = useSettings((s) => s.openSettings);
  const quickOpenShortcut = shortcutLabel(["Mod", "P"]);
  const searchShortcut = shortcutLabel(["Shift", "Mod", "F"]);
  const agentShortcut = shortcutLabel(["Shift", "Mod", "A"]);
  const graphShortcut = shortcutLabel(["Shift", "Mod", "G"]);
  const newWindowShortcut = shortcutLabel(["Shift", "Mod", "N"]);
  const settingsShortcut = shortcutLabel(["Mod", ","]);
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
          className={agentVisible ? "active" : ""}
          onClick={onToggleAgent}
          title={t("activity.agentPanel", { shortcut: agentShortcut })}
        >
          <SparkleIcon size={18} />
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
