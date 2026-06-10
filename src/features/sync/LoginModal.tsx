import { ipc } from "../../ipc/ipc";
import { useSync } from "../../stores/sync";

// GitHub Device Flow 안내: 코드를 보여주고 브라우저에서 승인하게 한다 (FR-4.1)
export function LoginModal() {
  const device = useSync((s) => s.device);
  const cancelLogin = useSync((s) => s.cancelLogin);

  if (!device) return null;

  return (
    <div className="modal-backdrop" onClick={cancelLogin}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>GitHub 로그인</h2>
        <p>아래 코드를 GitHub 인증 페이지에 입력하세요.</p>
        <div className="device-code">{device.userCode}</div>
        <div className="modal-actions">
          <button
            className="primary-btn"
            onClick={() => void ipc.openExternal(device.verificationUri)}
          >
            브라우저에서 인증 페이지 열기
          </button>
          <button
            onClick={() => void navigator.clipboard?.writeText(device.userCode)}
          >
            코드 복사
          </button>
          <button onClick={cancelLogin}>취소</button>
        </div>
        <p className="modal-hint">
          승인이 끝나면 자동으로 로그인됩니다… ({device.verificationUri})
        </p>
      </div>
    </div>
  );
}
