import { useEffect, useMemo, useRef, useState } from "react";
import { useCommandRegistry, type CommandDef } from "./registry";
import { SHORTCUTS } from "../../shared/shortcuts";
import { shortcutLabel } from "../../shared/platform";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n";

export interface PaletteItem {
  cmd: CommandDef;
  title: string;
  /** 단축키 바인딩이 있으면 플랫폼 라벨(⌥⌘T 등), 없으면 null */
  keyLabel: string | null;
}

/**
 * 팔레트에 보일 커맨드 목록: hideFromPalette 아님 + enabled 통과.
 * 번역된 제목에 부분 문자열 매칭(퍼지 없음 — QuickOpen 관례), 제목순 정렬.
 * translate 를 주입받아 순수 함수로 유지한다(테스트 용이).
 */
export function visiblePaletteCommands(
  commands: Record<string, CommandDef>,
  query: string,
  translate: (key: TranslationKey) => string,
): PaletteItem[] {
  const q = query.trim().toLowerCase();
  return Object.values(commands)
    .filter((c) => !c.hideFromPalette && (!c.enabled || c.enabled()))
    .map((cmd) => {
      const def = SHORTCUTS.find((s) => s.id === cmd.id);
      return {
        cmd,
        title: translate(cmd.titleKey),
        keyLabel: def ? shortcutLabel(def.keys) : null,
      };
    })
    .filter((it) => !q || it.title.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ⌘⇧P 커맨드 팔레트 — QuickOpenModal 과 같은 조작 관례(↑↓/Enter/Esc)
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const commands = useCommandRegistry((s) => s.commands);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const results = useMemo(
    () => visiblePaletteCommands(commands, query, t),
    [commands, query, t],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const pick = (i: number) => {
    const item = results[i];
    if (item) {
      onClose(); // 먼저 닫는다 — 커맨드가 다른 모달을 열 수 있다
      void item.cmd.run();
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
      <div className="quick-open command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("palette.placeholder")}
          spellCheck={false}
        />
        <ul>
          {results.map((item, i) => (
            <li key={item.cmd.id}>
              <button
                className={i === index ? "selected" : ""}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(i)}
              >
                <span className="qo-name">{item.title}</span>
                {item.keyLabel && <span className="palette-key">{item.keyLabel}</span>}
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="qo-empty">{t("palette.empty")}</li>}
        </ul>
      </div>
    </div>
  );
}
