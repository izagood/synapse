import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { basename } from "../../shared/pathUtils";
import { FolderIcon, ServerIcon } from "../../shared/Icons";
import { CloneForm } from "../sync/CloneForm";
import { StartUpdateBar } from "../update/StartUpdateBar";
import { RemoteConnect } from "./RemoteConnect";
import { OpenPathForm } from "./OpenPathForm";
import { openWorkspacePath } from "./openPath";
import { displayWorkspacePath, isRemoteWorkspace } from "./recentDisplay";
import { TitleBar } from "./TitleBar";

/**
 * 시작 화면: 단일 배경 위 중앙 2컬럼 — 왼쪽은 "시작하기"(폴더 열기·SSH·클론)와
 * "경로로 열기", 오른쪽은 "최근 폴더" 목록. 하단에 업데이트 알림 바.
 */
export function StartScreen() {
  const { recent, loading, error, openFolder, openRemote, clearRecent } = useWorkspace();
  const t = useT();

  // 최근 목록 클릭: 원격(ssh://)은 에이전트/키로 재연결을 시도한다. 비밀번호가
  // 필요한 호스트는 실패하므로, 그때는 "원격 폴더 열기" 폼으로 자격증명을 입력한다.
  const openRecent = (path: string) =>
    openWorkspacePath(path, { openFolder, openRemote });

  return (
    <div className="start-screen">
      {/* macOS Overlay 타이틀바 자리의 투명 드래그 스트립 (창 이동용) */}
      <TitleBar title="" />
      <div className="start-card">
        <header className="start-header">
          <h1 className="logo">Synapse</h1>
          <p className="tagline">{t("start.tagline")}</p>
        </header>

        <div className="start-columns">
          <section className="start-col">
            <h2 className="start-section-title">{t("start.gettingStarted")}</h2>

            <button
              className="start-action start-action-primary"
              onClick={() => void openFolder()}
              disabled={loading}
            >
              <FolderIcon className="start-action-icon" />
              <span className="start-action-label">{t("start.openFolder")}</span>
            </button>

            {error && <p className="error">{error}</p>}

            <RemoteConnect />

            <CloneForm />

            <OpenPathForm />
          </section>

          <section className="start-col start-recent">
            <div className="start-recent-header">
              <h2 className="start-section-title">{t("start.recentFolders")}</h2>
              {recent.length > 0 && (
                <button
                  className="start-clear-recent"
                  onClick={() => void clearRecent()}
                  disabled={loading}
                >
                  {t("start.clearRecent")}
                </button>
              )}
            </div>

            {recent.length > 0 ? (
              <ul className="recent-list">
                {recent.map((path) => (
                  <li key={path}>
                    <button
                      className="recent-item"
                      onClick={() => openRecent(path)}
                      disabled={loading}
                      title={path}
                    >
                      {isRemoteWorkspace(path) ? (
                        <ServerIcon className="recent-icon" />
                      ) : (
                        <FolderIcon className="recent-icon" />
                      )}
                      <span className="recent-info">
                        <span className="recent-title-row">
                          <span className="recent-name">{basename(path)}</span>
                          {isRemoteWorkspace(path) && (
                            <span className="recent-badge">SSH</span>
                          )}
                        </span>
                        <span className="recent-path">{displayWorkspacePath(path)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="start-recent-empty">{t("start.recentEmpty")}</p>
            )}
          </section>
        </div>

        <StartUpdateBar />
      </div>
    </div>
  );
}
