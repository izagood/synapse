import { useState } from "react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { ChevronIcon, GitHubIcon } from "../../shared/Icons";

function repoNameFrom(url: string): string {
  const tail = url.trim().replace(/\/+$/, "").split("/").pop() ?? "repo";
  return tail.replace(/\.git$/, "") || "repo";
}

// 기존 GitHub 리포지토리를 받아 새 워크스페이스로 연다 (FR-4.2).
// 시작 화면의 접이식 섹션: 닫힘 = 액션 버튼 한 줄, 열림 = URL 입력 폼.
export function CloneForm() {
  const openFolder = useWorkspace((s) => s.openFolder);
  const [open, setOpen] = useState(false);
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

  const toggle = () => {
    if (open) {
      setUrl("");
      setError(null);
    }
    setOpen(!open);
  };

  return (
    <div className="start-collapsible">
      <button className="start-action" onClick={toggle} disabled={busy} aria-expanded={open}>
        <GitHubIcon className="start-action-icon" />
        <span className="start-action-label">{t("sync.cloneTitle")}</span>
        <ChevronIcon className={`start-action-chevron${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <div className="start-panel">
          <div className="clone-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("sync.clonePlaceholder")}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && url.trim() && !busy) void clone();
              }}
            />
            <button disabled={busy || !url.trim()} onClick={() => void clone()}>
              {busy ? t("sync.cloning") : t("sync.clone")}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
