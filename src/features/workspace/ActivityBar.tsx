import { ipc } from "../../ipc/ipc";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import {
  FolderIcon,
  GearIcon,
  HomeIcon,
  NewWindowIcon,
  SearchIcon,
  SidebarIcon,
  SparkleIcon,
} from "../../shared/Icons";
import { shortcutLabel } from "../../shared/platform";

interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onQuickOpen: () => void;
  agentVisible: boolean;
  onToggleAgent: () => void;
}

// VS Code 액티비티 바: 상단 내비게이션 / 하단 폴더·설정
export function ActivityBar({
  sidebarVisible,
  onToggleSidebar,
  onQuickOpen,
  agentVisible,
  onToggleAgent,
}: ActivityBarProps) {
  const openFolder = useWorkspace((s) => s.openFolder);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const openSettings = useSettings((s) => s.openSettings);
  const quickOpenShortcut = shortcutLabel(["Mod", "P"]);
  const agentShortcut = shortcutLabel(["Shift", "Mod", "A"]);
  const newWindowShortcut = shortcutLabel(["Shift", "Mod", "N"]);
  const settingsShortcut = shortcutLabel(["Mod", ","]);

  return (
    <nav className="activity-bar">
      <div className="activity-top">
        <button
          className={sidebarVisible ? "active" : ""}
          onClick={onToggleSidebar}
          title="사이드바 토글"
        >
          <SidebarIcon size={18} />
        </button>
        <button onClick={onQuickOpen} title={`빠른 열기 (${quickOpenShortcut})`}>
          <SearchIcon size={18} />
        </button>
        <button
          className={agentVisible ? "active" : ""}
          onClick={onToggleAgent}
          title={`Claude 패널 (${agentShortcut})`}
        >
          <SparkleIcon size={18} />
        </button>
      </div>
      <div className="activity-bottom">
        <button
          onClick={() => void ipc.newWindow()}
          title={`새 창 (${newWindowShortcut}) - 다른 폴더를 동시에`}
        >
          <NewWindowIcon size={18} />
        </button>
        <button onClick={() => void openFolder()} title="다른 폴더 열기">
          <FolderIcon size={18} />
        </button>
        <button onClick={closeWorkspace} title="시작 화면으로">
          <HomeIcon size={18} />
        </button>
        <button onClick={openSettings} title={`설정 (${settingsShortcut})`}>
          <GearIcon size={18} />
        </button>
      </div>
    </nav>
  );
}
