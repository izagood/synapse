import { useEffect } from "react";
import { useUpdate } from "../../stores/update";
import { useT } from "../../i18n";

// 새 버전 알림 토스트: 앱 시작 시 1회 + 창 포커스 복귀 시(스테일하면) 자동 확인하고,
// 새 버전이 있으면 하단에 알림을 띄운다. "나중에"는 해당 버전만 세션 동안 억제.
export function UpdateToast() {
  const available = useUpdate((s) => s.available);
  const dismissedVersion = useUpdate((s) => s.dismissedVersion);
  const installing = useUpdate((s) => s.installing);
  const error = useUpdate((s) => s.error);
  const t = useT();

  useEffect(() => {
    const s = useUpdate.getState();
    if (!s.checked) void s.check();
    const onFocus = () => void useUpdate.getState().recheckIfStale();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!available || available === dismissedVersion) return null;

  return (
    <div className="update-toast" role="status">
      <span aria-hidden="true">🎁</span>
      <span className="update-toast-text">
        {t("update.toastMessage")} <strong>v{available}</strong>
      </span>
      {error && (
        <span className="update-toast-error" title={error}>
          {t("update.installFailed")}
        </span>
      )}
      <button
        className="update-toast-later"
        disabled={installing}
        onClick={() => useUpdate.getState().dismiss()}
      >
        {t("update.later")}
      </button>
      <button
        className="primary-btn update-toast-install"
        disabled={installing}
        onClick={() => void useUpdate.getState().install()}
        title={t("update.installTitle")}
      >
        {installing ? t("update.installing") : t("update.installNow")}
      </button>
    </div>
  );
}
