import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import type { RemoteConnectError } from "../../ipc/types";
import { RemoteBrowser } from "./RemoteBrowser";
import { ChevronIcon, ServerIcon } from "../../shared/Icons";

/**
 * 원격 SSH 폴더 열기 (시작 화면).
 *
 * `ssh ...` 명령어 한 줄을 받아 접속한 뒤(에이전트/키 우선, 필요 시 비밀번호),
 * 디렉터리 브라우저로 워크스페이스 루트를 고른다. 개별 필드 입력 대신
 * 명령어 + 탐색 방식으로 동작한다.
 */
export function RemoteConnect() {
  const connectRemoteSession = useWorkspace((s) => s.connectRemoteSession);
  const loading = useWorkspace((s) => s.loading);
  const t = useT();

  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // 에이전트/키 1차 실패 후에만 비밀번호 입력을 노출한다.
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pending, setPending] = useState<RemoteConnectError | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 접속 성공 후 디렉터리 브라우저의 시작점(원격 홈 URI).
  const [homeUri, setHomeUri] = useState<string | null>(null);

  const canConnect = !!command.trim() && !loading;

  const connect = async (acceptNewHostKey: boolean) => {
    setError(null);
    const result = await connectRemoteSession(command, {
      password: password || null,
      passphrase: passphrase || null,
      acceptNewHostKey,
    });
    if ("home" in result) {
      setPending(null);
      setHomeUri(result.home); // 접속 성공 → 브라우저로 전환
      return;
    }
    if (result.kind === "unknownHostKey" || result.kind === "hostKeyMismatch") {
      setPending(result);
    } else {
      setPending(null);
      // 일반 실패(인증 실패 등) → 비밀번호 입력을 열어 재시도하게 한다.
      setNeedsPassword(true);
      setError(result.message);
    }
  };

  const reset = () => {
    setCommand("");
    setPassword("");
    setPassphrase("");
    setNeedsPassword(false);
    setPending(null);
    setError(null);
    setHomeUri(null);
    setOpen(false);
  };

  // 접이식 섹션: 닫힘 = 액션 버튼 한 줄, 열림 = 버튼 아래 연결 폼
  // (접속 성공 후에는 디렉터리 브라우저)이 펼쳐진다.
  return (
    <div className="start-collapsible">
      <button
        className="start-action"
        onClick={() => (open ? reset() : setOpen(true))}
        disabled={loading}
        aria-expanded={open}
      >
        <ServerIcon className="start-action-icon" />
        <span className="start-action-label">{t("start.openRemote")}</span>
        <ChevronIcon className={`start-action-chevron${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <div className="start-panel">
          {homeUri ? (
            // 접속됨 → 디렉터리 브라우저로 폴더 선택.
            <RemoteBrowser homeUri={homeUri} onCancel={reset} />
          ) : (
            <>
              <input
                className="remote-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t("start.remote.commandPlaceholder")}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canConnect) void connect(false);
                }}
              />
              <p className="remote-command-hint">{t("start.remote.commandHint")}</p>

              {needsPassword && (
                <>
                  <p className="remote-command-hint">{t("start.remote.passwordNeeded")}</p>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("start.remote.password")}
                  />
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder={t("start.remote.passphrase")}
                  />
                </>
              )}

              {pending?.kind === "unknownHostKey" && (
                <div className="host-key-prompt">
                  <p>{t("start.remote.unknownHostKey")}</p>
                  <code>{pending.fingerprint}</code>
                  <button onClick={() => void connect(true)} disabled={loading}>
                    {t("start.remote.trustAndConnect")}
                  </button>
                </div>
              )}
              {pending?.kind === "hostKeyMismatch" && (
                <p className="error">
                  {t("start.remote.hostKeyMismatch", { fingerprint: pending.fingerprint })}
                </p>
              )}
              {error && <p className="error">{error}</p>}

              <div className="remote-actions">
                <button
                  className="primary-btn"
                  onClick={() => void connect(false)}
                  disabled={!canConnect}
                >
                  {loading ? t("start.remote.connecting") : t("start.remote.connect")}
                </button>
                <button onClick={reset} disabled={loading}>
                  {t("start.remote.cancel")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
