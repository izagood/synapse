import { useEffect, useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import { useT } from "../../i18n";
import type { RemoteDirEntry } from "../../ipc/types";
import {
  splitRemoteUri,
  joinRemoteUri,
  posixDirname,
  posixJoin,
} from "./remoteUri";

/**
 * 접속된 원격 세션의 디렉터리를 탐색해 워크스페이스로 열 폴더를 고르는 패널.
 * 권한부(base)는 고정한 채 POSIX 경로만 오르내리고, "이 폴더 열기"를 누르면
 * 캐시된 세션으로 `openFolder`가 (재접속 없이) 트리를 연다.
 */
export function RemoteBrowser({
  homeUri,
  onCancel,
}: {
  homeUri: string;
  onCancel: () => void;
}) {
  const openFolder = useWorkspace((s) => s.openFolder);
  const loading = useWorkspace((s) => s.loading);
  const t = useT();

  const [currentUri, setCurrentUri] = useState(homeUri);
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [listing, setListing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { base, path } = splitRemoteUri(currentUri);

  useEffect(() => {
    let cancelled = false;
    setListing(true);
    setError(null);
    ipc
      .listRemoteDir(currentUri)
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setListing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUri]);

  const enter = (name: string) =>
    setCurrentUri(joinRemoteUri(base, posixJoin(path, name)));
  const goUp = () => setCurrentUri(joinRemoteUri(base, posixDirname(path)));

  const cancel = () => {
    // 고르지 않고 닫으면 방금 맺은 세션은 쓰이지 않으므로 정리한다.
    void ipc.disconnectRemote(base);
    onCancel();
  };

  return (
    <div className="remote-connect">
      <h2>{t("start.remote.browseTitle")}</h2>
      <div className="remote-browser-path" title={currentUri}>
        {path}
      </div>

      <div className="remote-browser-list">
        <button
          className="remote-browser-entry remote-browser-up"
          onClick={goUp}
          disabled={path === "/" || listing}
        >
          <span aria-hidden>↑</span> {t("start.remote.parentDir")}
        </button>

        {listing && <p className="remote-browser-info">{t("start.remote.loadingDir")}</p>}
        {error && <p className="error">{error}</p>}
        {!listing && !error && entries.length === 0 && (
          <p className="remote-browser-info">{t("start.remote.emptyDir")}</p>
        )}

        {!listing &&
          !error &&
          entries.map((e) =>
            e.isDir ? (
              <button
                key={e.name}
                className="remote-browser-entry"
                onClick={() => enter(e.name)}
              >
                <span aria-hidden>📁</span> {e.name}
              </button>
            ) : (
              <div
                key={e.name}
                className="remote-browser-entry remote-browser-file"
              >
                <span aria-hidden>📄</span> {e.name}
              </div>
            ),
          )}
      </div>

      <div className="remote-actions">
        <button
          className="primary-btn"
          onClick={() => void openFolder(currentUri)}
          disabled={loading || listing}
        >
          {loading ? t("start.remote.connecting") : t("start.remote.openThisFolder")}
        </button>
        <button onClick={cancel} disabled={loading}>
          {t("start.remote.cancel")}
        </button>
      </div>
    </div>
  );
}
