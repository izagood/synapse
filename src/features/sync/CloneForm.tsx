import { useState } from "react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";

function repoNameFrom(url: string): string {
  const tail = url.trim().replace(/\/+$/, "").split("/").pop() ?? "repo";
  return tail.replace(/\.git$/, "") || "repo";
}

// 기존 GitHub 리포지토리를 받아 새 워크스페이스로 연다 (FR-4.2)
export function CloneForm() {
  const openFolder = useWorkspace((s) => s.openFolder);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const clone = async () => {
    setError(null);
    setBusy(true);
    try {
      const parent = await ipc.pickFolder(); // 클론 받을 위치 선택
      if (!parent) return;
      const dest = await ipc.cloneRepo(url.trim(), parent, repoNameFrom(url));
      await openFolder(dest);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clone-form">
      <h2>{t("sync.cloneTitle")}</h2>
      <div className="clone-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("sync.clonePlaceholder")}
          spellCheck={false}
        />
        <button disabled={busy || !url.trim()} onClick={() => void clone()}>
          {busy ? t("sync.cloning") : t("sync.clone")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
