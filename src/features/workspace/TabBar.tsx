import { isDirty, useWorkspace } from "../../stores/workspace";

export function TabBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activePath = useWorkspace((s) => s.activePath);
  const docs = useWorkspace((s) => s.docs);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const closeTab = useWorkspace((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`tab${tab.path === activePath ? " active" : ""}`}
          role="tab"
          aria-selected={tab.path === activePath}
        >
          <button
            className="tab-label"
            title={tab.path}
            onClick={() => setActiveTab(tab.path)}
          >
            {isDirty(docs[tab.path]) && <span className="tab-dirty">●</span>}
            {tab.name}
          </button>
          <button
            className="tab-close"
            title="탭 닫기"
            onClick={() => void closeTab(tab.path)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
