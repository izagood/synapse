import { detectDesktopPlatform, type DesktopPlatform } from "../../shared/platform";
import { SearchIcon } from "../../shared/Icons";
import { useT } from "../../i18n";

/**
 * macOS 전용 커스텀 타이틀바 (VS Code command center 방식).
 * tauri.conf.json 의 titleBarStyle=Overlay + hiddenTitle 로 네이티브 제목을
 * 숨기고 이 스트립이 그 자리를 대신한다 — 신호등 버튼은 좌측에 그대로 떠 있다.
 * data-tauri-drag-region: 빈 영역 드래그=창 이동, 더블클릭=확대/복원을 Tauri가
 * 처리한다. 이벤트 대상이 스트립 자신일 때만 동작하므로 자식 버튼 클릭은
 * 방해받지 않는다. Windows/Linux 는 네이티브 타이틀바가 남으므로 그리지 않는다.
 */
export function TitleBar({
  title,
  onOpenPalette,
  platform = detectDesktopPlatform(),
}: {
  title: string;
  /** 있으면 중앙 제목이 커맨드 팔레트를 여는 버튼(command center)이 된다 */
  onOpenPalette?: () => void;
  platform?: DesktopPlatform;
}) {
  const t = useT();
  if (platform !== "macos") return null;
  return (
    <div className="titlebar" data-tauri-drag-region>
      {onOpenPalette ? (
        <button
          className="titlebar-command-center"
          onClick={onOpenPalette}
          title={t("shortcuts.desc.palette")}
        >
          <SearchIcon size={12} />
          <span className="titlebar-label">{title}</span>
        </button>
      ) : (
        <span className="titlebar-label titlebar-label-static">{title}</span>
      )}
    </div>
  );
}
