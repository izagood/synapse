import { useEffect, useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import type { Backlink } from "../../ipc/types";
import { useT } from "../../i18n";
import { ChevronIcon, FileTextIcon } from "../../shared/Icons";

const COLLAPSED_KEY = "synapse.backlinksCollapsed";

// 현재 활성 노트를 가리키는 다른 노트(백링크)를 보여주는 패널 (FR-2.8 → FR-6.1).
// 에디터 영역 하단에 접이식으로 붙는다. 항목 클릭 시 해당 노트를 연다.
export function BacklinksPanel() {
  const root = useWorkspace((s) => s.root);
  const activePath = useWorkspace((s) => s.activePath);
  const openFileAt = useWorkspace((s) => s.openFileAt);
  // 저장으로 백링크가 바뀔 수 있으니 활성 문서의 savedContent 변화를 트리거로 쓴다
  const savedContent = useWorkspace((s) =>
    s.activePath ? s.docs[s.activePath]?.savedContent : undefined,
  );
  const t = useT();

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  const [links, setLinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!root || !activePath) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    ipc
      .backlinks(root, activePath)
      .then((result) => {
        if (!cancelled) setLinks(result);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, activePath, savedContent]);

  const toggle = () => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
      return !v;
    });
  };

  if (!activePath) return null;

  return (
    <div className="backlinks-panel">
      <button
        className="backlinks-header"
        onClick={toggle}
        title={collapsed ? t("backlinks.show") : t("backlinks.hide")}
      >
        <ChevronIcon
          size={13}
          className="backlinks-chevron"
          style={{ transform: collapsed ? "none" : "rotate(90deg)" }}
        />
        <span className="backlinks-title">{t("backlinks.title")}</span>
        {!loading && links.length > 0 && (
          <span className="backlinks-badge">{links.length}</span>
        )}
      </button>
      {!collapsed && (
        <div className="backlinks-body">
          {loading ? (
            <p className="backlinks-empty">{t("backlinks.loading")}</p>
          ) : links.length === 0 ? (
            <p className="backlinks-empty">{t("backlinks.empty")}</p>
          ) : (
            <ul className="backlinks-list">
              {links.map((b, i) => (
                <li key={`${b.sourcePath}:${i}`}>
                  <button
                    className="backlinks-item"
                    onClick={() => void openFileAt(b.sourcePath)}
                    title={b.sourcePath}
                  >
                    <span className="backlinks-item-name">
                      <FileTextIcon size={13} />
                      {b.sourceName}
                    </span>
                    {b.snippet && (
                      <span className="backlinks-item-snippet">{b.snippet}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
