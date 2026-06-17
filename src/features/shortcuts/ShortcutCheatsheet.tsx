import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../stores/settings";
import { useT } from "../../i18n";
import { detectDesktopPlatform, shortcutLabel } from "../../shared/platform";
import { SHORTCUTS } from "../../shared/shortcuts";
import { filterShortcuts, groupByCategory, visibleShortcuts } from "./cheatsheet";

// 단축키 치트시트: 카테고리별 목록 + 상단 검색. 보기 전용(명령 실행 없음).
// 플랫폼(macOS/Windows)에 맞춘 키 라벨을 shortcutLabel 로 표시한다.
export function ShortcutCheatsheet() {
  const show = useSettings((s) => s.showShortcuts);
  const close = useSettings((s) => s.closeShortcuts);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const platform = useMemo(() => detectDesktopPlatform(), []);
  const groups = useMemo(
    () => groupByCategory(filterShortcuts(visibleShortcuts(SHORTCUTS, platform), query, t, platform)),
    [platform, query, t],
  );

  // 열릴 때마다 검색을 비우고 입력에 포커스
  useEffect(() => {
    if (show) {
      setQuery("");
      inputRef.current?.focus();
    }
  }, [show]);

  if (!show) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  return (
    <div className="modal-backdrop quick-open-backdrop" onClick={close}>
      <div className="cheatsheet" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("shortcuts.searchPlaceholder")}
          spellCheck={false}
        />
        <div className="cheatsheet-body">
          {groups.map((group) => (
            <section key={group.category}>
              <h3>{t(`shortcuts.category.${group.category}`)}</h3>
              <ul>
                {group.items.map((def) => (
                  <li key={def.id}>
                    <span className="cheatsheet-desc">{t(def.descriptionKey)}</span>
                    <kbd className="cheatsheet-keys">{shortcutLabel(def.keys, platform)}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && <p className="cheatsheet-empty">{t("shortcuts.empty")}</p>}
        </div>
      </div>
    </div>
  );
}
