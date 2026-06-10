import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import {
  FolderIcon,
  GearIcon,
  HomeIcon,
  SearchIcon,
  SidebarIcon,
} from "../../shared/Icons";

interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onQuickOpen: () => void;
}

// VS Code 액티비티 바: 상단 내비게이션 / 하단 폴더·설정
export function ActivityBar({ sidebarVisible, onToggleSidebar, onQuickOpen }: ActivityBarProps) {
  const openFolder = useWorkspace((s) => s.openFolder);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const openSettings = useSettings((s) => s.openSettings);

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
        <button onClick={onQuickOpen} title="빠른 열기 (⌘P)">
          <SearchIcon size={18} />
        </button>
      </div>
      <div className="activity-bottom">
        <button onClick={() => void openFolder()} title="다른 폴더 열기">
          <FolderIcon size={18} />
        </button>
        <button onClick={closeWorkspace} title="시작 화면으로">
          <HomeIcon size={18} />
        </button>
        <button onClick={openSettings} title="설정 (⌘,)">
          <GearIcon size={18} />
        </button>
      </div>
    </nav>
  );
}
