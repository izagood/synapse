import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import { useT } from "../../i18n";
import type { RemoteConnectError } from "../../ipc/types";

/** 입력 필드로 `ssh://user@host[:port][/path]` URI를 만든다. */
export function buildSshUri(
  user: string,
  host: string,
  port: string,
  path: string,
): string {
  const p = port.trim();
  const portPart = p && p !== "22" ? `:${p}` : "";
  // IPv6 리터럴은 대괄호로 감싼다.
  const hostTrim = host.trim();
  const h =
    hostTrim.includes(":") && !hostTrim.startsWith("[")
      ? `[${hostTrim}]`
      : hostTrim;
  const trimmedPath = path.trim();
  const pathPart = trimmedPath
    ? trimmedPath.startsWith("/")
      ? trimmedPath
      : `/${trimmedPath}`
    : "";
  return `ssh://${user.trim()}@${h}${portPart}${pathPart}`;
}

/** 원격 SSH 폴더를 워크스페이스로 여는 폼 (시작 화면). */
export function RemoteConnect() {
  const openRemote = useWorkspace((s) => s.openRemote);
  const loading = useWorkspace((s) => s.loading);
  const t = useT();

  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [path, setPath] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [pending, setPending] = useState<RemoteConnectError | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canConnect = !!host.trim() && !!user.trim() && !loading;

  const connect = async (acceptNewHostKey: boolean) => {
    setError(null);
    const uri = buildSshUri(user, host, port, path);
    const result = await openRemote(uri, {
      keyPath: keyPath || null,
      password: password || null,
      passphrase: passphrase || null,
      acceptNewHostKey,
    });
    if (!result) {
      setPending(null); // 성공 — 워크스페이스로 전환된다
      return;
    }
    if (result.kind === "unknownHostKey" || result.kind === "hostKeyMismatch") {
      setPending(result);
    } else {
      setPending(null);
      setError(result.message);
    }
  };

  if (!open) {
    return (
      <button
        className="remote-open-btn"
        onClick={() => setOpen(true)}
        disabled={loading}
      >
        {t("start.openRemote")}
      </button>
    );
  }

  return (
    <div className="remote-connect">
      <h2>{t("start.remote.title")}</h2>
      <div className="remote-row">
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder={t("start.remote.user")}
          spellCheck={false}
          autoCapitalize="off"
        />
        <span aria-hidden>@</span>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t("start.remote.host")}
          spellCheck={false}
          autoCapitalize="off"
        />
        <span aria-hidden>:</span>
        <input
          className="remote-port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder={t("start.remote.port")}
          inputMode="numeric"
        />
      </div>
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder={t("start.remote.path")}
        spellCheck={false}
        autoCapitalize="off"
      />
      <div className="remote-key-row">
        <input
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          placeholder={t("start.remote.keyPath")}
          spellCheck={false}
          autoCapitalize="off"
        />
        <button
          type="button"
          onClick={() => void ipc.pickFile().then((p) => p && setKeyPath(p))}
          disabled={loading}
        >
          {t("start.remote.browse")}
        </button>
      </div>
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
        <button onClick={() => setOpen(false)} disabled={loading}>
          {t("start.remote.cancel")}
        </button>
      </div>
    </div>
  );
}
