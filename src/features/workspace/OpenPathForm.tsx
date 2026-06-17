import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { openWorkspacePath } from "./openPath";

/**
 * 경로를 직접 입력/붙여넣어 워크스페이스를 여는 폼 (시작 화면).
 * 다이얼로그를 거치지 않고 절대 경로나 `ssh://` URI를 그대로 붙여넣을 수 있다.
 */
export function OpenPathForm() {
  const openFolder = useWorkspace((s) => s.openFolder);
  const openRemote = useWorkspace((s) => s.openRemote);
  const loading = useWorkspace((s) => s.loading);
  const t = useT();
  const [path, setPath] = useState("");

  const submit = () => {
    if (openWorkspacePath(path, { openFolder, openRemote })) setPath("");
  };

  return (
    <div className="open-path">
      <h2>{t("start.openByPath")}</h2>
      <div className="open-path-row">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={t("start.openByPathPlaceholder")}
          spellCheck={false}
          autoCapitalize="off"
        />
        <button disabled={loading || !path.trim()} onClick={submit}>
          {t("start.openByPathSubmit")}
        </button>
      </div>
    </div>
  );
}
