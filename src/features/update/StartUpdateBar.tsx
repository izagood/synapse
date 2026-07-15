import { useUpdate } from "../../stores/update";
import { useT } from "../../i18n";
import { useUpdateAutoCheck } from "./useUpdateAutoCheck";

// 시작 화면 카드 하단의 업데이트 알림 바. 토스트(UpdateToast)와 같은 상태를
// 쓰되, 시작 화면에서는 떠 있는 토스트 대신 카드 푸터로 자리를 잡는다.
// "나중에"는 토스트와 동일하게 해당 버전만 세션 동안 억제한다.
export function StartUpdateBar() {
  useUpdateAutoCheck();
  const available = useUpdate((s) => s.available);
  const dismissedVersion = useUpdate((s) => s.dismissedVersion);
  const installing = useUpdate((s) => s.installing);
  const error = useUpdate((s) => s.error);
  const t = useT();

  if (!available || available === dismissedVersion) return null;

  return (
    <div className="start-update-bar" role="status">
      <span className="start-update-text">
        {t("update.availableVersion", { version: available })}
      </span>
      {error && (
        <span className="update-toast-error" title={error}>
          {t("update.installFailed")}
        </span>
      )}
      <div className="start-update-actions">
        <button
          className="start-update-install"
          disabled={installing}
          onClick={() => void useUpdate.getState().install()}
          title={t("update.installTitle")}
        >
          {installing ? t("update.installing") : t("update.installNow")}
        </button>
        <button
          className="start-update-later"
          disabled={installing}
          onClick={() => useUpdate.getState().dismiss()}
        >
          {t("update.later")}
        </button>
      </div>
    </div>
  );
}
