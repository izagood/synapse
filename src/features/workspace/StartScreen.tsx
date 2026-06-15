import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { basename } from "../../shared/pathUtils";
import { CloneForm } from "../sync/CloneForm";
import { RemoteConnect } from "./RemoteConnect";

export function StartScreen() {
  const { recent, loading, error, openFolder } = useWorkspace();
  const t = useT();

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
                    onClick={() => void openFolder(path)}
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
