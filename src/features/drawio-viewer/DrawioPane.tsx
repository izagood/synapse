import { useState } from "react";
import { useT } from "../../i18n";
import { DrawioViewer } from "./DrawioViewer";
import { DrawioEditor } from "./DrawioEditor";

// `.drawio` 노트 표시. 기본은 가벼운 오프라인 뷰어이고, "편집" 버튼으로 번들된
// 전체 drawio 에디터로 전환한다. 에디터는 autosave 로 파일을 갱신하므로 뷰어로
// 돌아오면 최신 내용이 보인다.
export function DrawioPane({ path }: { path: string }) {
  const [editing, setEditing] = useState(false);
  const t = useT();

  return (
    <div className="drawio-pane">
      {editing ? (
        <DrawioEditor key={`${path}:edit`} path={path} onExit={() => setEditing(false)} />
      ) : (
        <DrawioViewer key={`${path}:view`} path={path} />
      )}
      <button
        type="button"
        className="drawio-mode-toggle"
        onClick={() => setEditing((v) => !v)}
      >
        {editing ? t("drawio.view") : t("drawio.edit")}
      </button>
    </div>
  );
}
