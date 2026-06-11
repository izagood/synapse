import { ipc } from "../../ipc/ipc";
import { useSync } from "../../stores/sync";
import { useT } from "../../i18n";

// GitHub Device Flow 안내: 코드를 보여주고 브라우저에서 승인하게 한다 (FR-4.1)
export function LoginModal() {
  const device = useSync((s) => s.device);
  const cancelLogin = useSync((s) => s.cancelLogin);
  const t = useT();

  if (!device) return null;

  return (
    <div className="modal-backdrop" onClick={cancelLogin}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("sync.login")}</h2>
        <p>{t("sync.loginInstruction")}</p>
        <div className="device-code">{device.userCode}</div>
        <div className="modal-actions">
          <button
            className="primary-btn"
            onClick={() => void ipc.openExternal(device.verificationUri)}
          >
            {t("sync.openAuthPage")}
          </button>
          <button
            onClick={() => void navigator.clipboard?.writeText(device.userCode)}
          >
            {t("sync.copyCode")}
          </button>
          <button onClick={cancelLogin}>{t("common.cancel")}</button>
        </div>
        <p className="modal-hint">
          {t("sync.loginPending", { uri: device.verificationUri })}
        </p>
      </div>
    </div>
  );
}
