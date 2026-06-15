import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useT } from "../../i18n";
import {
  clearSearch,
  getSearchInfo,
  setSearchTerm,
  stepMatch,
} from "./search";

// 문서 내 찾기 바 — 에디터 우상단에 떠서 매치를 탐색한다.
// focusSignal이 바뀌면 입력에 다시 포커스해 텍스트를 전부 선택한다
// (Cmd/Ctrl+F 재입력 시 즉시 새 검색을 시작할 수 있도록).
export function FindBar({
  editor,
  focusSignal,
  onClose,
}: {
  editor: Editor;
  focusSignal: number;
  onClose: () => void;
}) {
  const t = useT();
  const [term, setTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [info, setInfo] = useState({ total: 0, current: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  // 마운트 시점에 검색 상태를 정리하고, 언마운트 시 하이라이트를 제거한다.
  useEffect(() => {
    return () => clearSearch(editor);
  }, [editor]);

  // 검색어/옵션이 바뀌면 다시 검색하고 카운트를 갱신
  useEffect(() => {
    setSearchTerm(editor, term, caseSensitive);
    setInfo(getSearchInfo(editor));
  }, [editor, term, caseSensitive]);

  // 열릴 때마다(Cmd+F) 입력에 포커스 + 전체 선택
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  function go(dir: 1 | -1) {
    stepMatch(editor, dir);
    setInfo(getSearchInfo(editor));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    }
  }

  const countLabel =
    term === ""
      ? ""
      : info.total === 0
        ? t("editor.find.noResults")
        : t("editor.find.count", { current: info.current, total: info.total });

  return (
    <div className="find-bar" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="find-input"
        value={term}
        placeholder={t("editor.find.placeholder")}
        onChange={(e) => setTerm(e.target.value)}
        spellCheck={false}
        aria-label={t("editor.find.placeholder")}
      />
      <span className={`find-count${info.total === 0 && term !== "" ? " find-count-empty" : ""}`}>
        {countLabel}
      </span>
      <button
        className={caseSensitive ? "find-toggle active" : "find-toggle"}
        onClick={() => setCaseSensitive((v) => !v)}
        title={t("editor.find.caseSensitive")}
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <button
        className="find-nav"
        onClick={() => go(-1)}
        disabled={info.total === 0}
        title={t("editor.find.previous")}
        aria-label={t("editor.find.previous")}
      >
        ↑
      </button>
      <button
        className="find-nav"
        onClick={() => go(1)}
        disabled={info.total === 0}
        title={t("editor.find.next")}
        aria-label={t("editor.find.next")}
      >
        ↓
      </button>
      <button
        className="find-close"
        onClick={onClose}
        title={t("common.close")}
        aria-label={t("common.close")}
      >
        ×
      </button>
    </div>
  );
}
