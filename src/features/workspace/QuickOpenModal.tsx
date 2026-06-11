import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { filterQuickOpen, flattenFiles } from "./quickOpen";

export function QuickOpenModal({ onClose }: { onClose: () => void }) {
  const tree = useWorkspace((s) => s.tree);
  const openFile = useWorkspace((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const items = useMemo(() => flattenFiles(tree), [tree]);
  const results = useMemo(() => filterQuickOpen(items, query), [items, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const pick = (i: number) => {
    const item = results[i];
    if (item) {
      void openFile(item.node);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(index);
    }
  };

  return (
    <div className="modal-backdrop quick-open-backdrop" onClick={onClose}>
      <div className="quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("quickOpen.placeholder")}
          spellCheck={false}
        />
        <ul>
          {results.map((item, i) => (
            <li key={item.node.path}>
              <button
                className={i === index ? "selected" : ""}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(i)}
              >
                <span className="qo-name">{item.node.name}</span>
                <span className="qo-path">{item.relPath}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="qo-empty">{t("quickOpen.empty")}</li>}
        </ul>
      </div>
    </div>
  );
}
