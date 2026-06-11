import { useEffect } from "react";
import { useUpdate } from "../../stores/update";

// 새 버전 알림 토스트: 앱 시작 시 1회 + 창 포커스 복귀 시(스테일하면) 자동 확인하고,
// 새 버전이 있으면 하단에 알림을 띄운다. "나중에"는 해당 버전만 세션 동안 억제.
export function UpdateToast() {
  const available = useUpdate((s) => s.available);
  const dismissedVersion = useUpdate((s) => s.dismissedVersion);
  const installing = useUpdate((s) => s.installing);
  const error = useUpdate((s) => s.error);

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
        새 업데이트가 있습니다 <strong>v{available}</strong>
      </span>
      {error && (
        <span className="update-toast-error" title={error}>
          설치 실패
        </span>
      )}
      <button
        className="update-toast-later"
        disabled={installing}
        onClick={() => useUpdate.getState().dismiss()}
      >
        나중에
      </button>
      <button
        className="primary-btn update-toast-install"
        disabled={installing}
        onClick={() => void useUpdate.getState().install()}
        title="다운로드 후 자동 재시작됩니다"
      >
        {installing ? "설치 중…" : "지금 설치"}
      </button>
    </div>
  );
}
