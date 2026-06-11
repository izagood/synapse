import { useUpdate } from "../../stores/update";
import { useT } from "../../i18n";

// 상태바 우측: 새 버전이 있을 때만 나타나는 원클릭 업데이트 버튼 (F2)
// 자동 확인은 앱 전역의 UpdateToast가 담당한다.
export function UpdateBadge() {
  const { available, installing, install } = useUpdate();
  const t = useT();

  if (!available) return null;

  return (
    <button
      className="update-badge"
      disabled={installing}
      onClick={() => void install()}
      title={t("update.badgeTitle", { version: available })}
    >
      {installing
        ? t("update.badgeInstalling")
        : t("update.badgeUpdate", { version: available })}
    </button>
  );
}
