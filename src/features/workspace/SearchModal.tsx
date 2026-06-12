import { useEffect, useRef, useState } from "react";
import { ipc } from "../../ipc/ipc";
import type { SearchHit } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { toRelativePath } from "../../shared/pathUtils";
import { highlightSnippet } from "./searchHighlight";

const DEBOUNCE_MS = 180;

// 전체 텍스트 검색 오버레이 (FR-1.5). 파일명+내용을 검색하고,
// 매치를 클릭하면 해당 파일을 연다. 라인 단위 스크롤은 후속 과제.
export function SearchModal({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const openFileAt = useWorkspace((s) => s.openFileAt);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 입력 디바운스 후 검색. 경쟁 상태를 막기 위해 stale 응답은 버린다.
  useEffect(() => {
    const trimmed = query.trim();
    if (!root || !trimmed) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      ipc
        .searchWorkspace(root, trimmed)
        .then((results) => {
          if (!cancelled) setHits(results);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, root]);

  const open = (path: string) => {
    void openFileAt(path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  const relPath = (path: string) => (root ? toRelativePath(root, path) : path);

  const showEmpty = !searching && query.trim() !== "" && hits.length === 0;

  return (
    <div className="modal-backdrop quick-open-backdrop" onClick={onClose}>
      <div className="quick-open search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("search.placeholder")}
          spellCheck={false}
        />
        <ul className="search-results">
          {hits.map((hit) => (
            <li key={hit.path} className="search-file">
              <button
                className="search-file-header"
                onClick={() => open(hit.path)}
                title={hit.path}
              >
                <span className="qo-name">{hit.name}</span>
                <span className="qo-path">{relPath(hit.path)}</span>
              </button>
              {hit.matches.map((m, i) => (
                <button
                  key={`${hit.path}:${m.line}:${i}`}
                  className="search-match"
                  onClick={() => open(hit.path)}
                >
                  <span className="search-line">{m.line}</span>
                  <span className="search-snippet">
                    {highlightSnippet(m.snippet, query).map((seg, j) =>
                      seg.match ? (
                        <mark key={j}>{seg.text}</mark>
                      ) : (
                        <span key={j}>{seg.text}</span>
                      ),
                    )}
                  </span>
                </button>
              ))}
            </li>
          ))}
          {showEmpty && <li className="qo-empty">{t("search.empty")}</li>}
        </ul>
      </div>
    </div>
  );
}
