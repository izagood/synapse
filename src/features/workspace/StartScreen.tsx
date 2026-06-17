import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { basename } from "../../shared/pathUtils";
import { CloneForm } from "../sync/CloneForm";
import { RemoteConnect } from "./RemoteConnect";
import { OpenPathForm } from "./OpenPathForm";
import { openWorkspacePath } from "./openPath";

export function StartScreen() {
  const { recent, loading, error, openFolder, openRemote } = useWorkspace();
  const t = useT();

  // 최근 목록 클릭: 원격(ssh://)은 에이전트/키로 재연결을 시도한다. 비밀번호가
  // 필요한 호스트는 실패하므로, 그때는 "원격 폴더 열기" 폼으로 자격증명을 입력한다.
  const openRecent = (path: string) =>
    openWorkspacePath(path, { openFolder, openRemote });

  return (
    <div className="start-screen">
      <div className="start-card">
        <h1 className="logo">Synapse</h1>
        <p className="tagline">{t("start.tagline")}</p>

        <button
          className="primary-btn"
          onClick={() => void openFolder()}
          disabled={loading}
        >
          {t("start.openFolder")}
        </button>

        {error && <p className="error">{error}</p>}

        <OpenPathForm />

        <RemoteConnect />

        <CloneForm />

        {recent.length > 0 && (
          <div className="recent">
            <h2>{t("start.recentFolders")}</h2>
            <ul>
              {recent.map((path) => (
                <li key={path}>
                  <button
                    className="recent-item"
                    onClick={() => openRecent(path)}
                    disabled={loading}
                    title={path}
                  >
                    <span className="recent-name">{basename(path)}</span>
                    <span className="recent-path">{path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
