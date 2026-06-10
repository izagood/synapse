import { useWorkspace } from "../../stores/workspace";

export function StartScreen() {
  const { recent, loading, error, openFolder } = useWorkspace();

  return (
    <div className="start-screen">
      <div className="start-card">
        <h1 className="logo">Synapse</h1>
        <p className="tagline">편집은 Notion처럼, 저장은 Markdown으로</p>

        <button
          className="primary-btn"
          onClick={() => void openFolder()}
          disabled={loading}
        >
          폴더 열기
        </button>

        {error && <p className="error">{error}</p>}

        {recent.length > 0 && (
          <div className="recent">
            <h2>최근 폴더</h2>
            <ul>
              {recent.map((path) => (
                <li key={path}>
                  <button
                    className="recent-item"
                    onClick={() => void openFolder(path)}
                    disabled={loading}
                    title={path}
                  >
                    <span className="recent-name">{path.split("/").pop() || path}</span>
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
