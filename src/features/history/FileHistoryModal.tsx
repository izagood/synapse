import { useEffect, useState } from "react";
import { ipc } from "../../ipc/ipc";
import type { FileCommit } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { useSettings } from "../../stores/settings";
import { useT } from "../../i18n";
import { basename, fileTypeOf } from "../../shared/pathUtils";
import { commitTitle, formatCommitTime } from "./format";

export function FileHistoryModal({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const root = useWorkspace((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);
  const updateContent = useWorkspace((s) => s.updateContent);
  const saveDoc = useWorkspace((s) => s.saveDoc);
  const language = useSettings((s) => s.settings.appearance.language);
  const t = useT();

  const [commits, setCommits] = useState<FileCommit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileCommit | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const name = basename(path);

  // 히스토리 목록 로드
  useEffect(() => {
    let alive = true;
    if (!root) return;
    setCommits(null);
    setLoadError(null);
    ipc
      .fileHistory(root, path)
      .then((list) => {
        if (!alive) return;
        setCommits(list);
        if (list[0]) setSelected(list[0]);
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, path]);

  // 선택된 버전 내용(미리보기) 로드
  useEffect(() => {
    let alive = true;
    if (!root || !selected) {
      setPreview(null);
      return;
    }
    setPreview(null);
    setPreviewLoading(true);
    setRestoreError(null);
    ipc
      .fileAtRevision(root, path, selected.hash)
      .then((text) => alive && setPreview(text))
      .catch((e) => alive && setRestoreError(String(e)))
      .finally(() => alive && setPreviewLoading(false));
    return () => {
      alive = false;
    };
  }, [root, path, selected]);

  // Escape로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async () => {
    if (preview === null || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      // CRDT 일관성을 위해 파일을 직접 덮어쓰지 않고 기존 저장 경로를 탄다:
      // 탭을 열어 로드한 뒤 content를 갈아끼우고 saveDoc(=save_doc)으로 저장한다.
      await openFile({ path, name, kind: "file", fileType: fileTypeOf(name) });
      updateContent(path, preview);
      await saveDoc(path);
      onClose();
    } catch (e) {
      setRestoreError(String(e));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal history-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-header">
          <h2>{t("history.title")}</h2>
          <span className="history-file" title={path}>
            {name}
          </span>
        </div>

        <div className="history-body">
          <div className="history-list">
            {commits === null && !loadError && (
              <p className="history-status">{t("history.loading")}</p>
            )}
            {loadError && <p className="history-status error">{loadError}</p>}
            {commits !== null && commits.length === 0 && (
              <p className="history-status">{t("history.empty")}</p>
            )}
            {commits?.map((commit, i) => (
              <button
                key={commit.hash}
                className={`history-item${selected?.hash === commit.hash ? " selected" : ""}`}
                onClick={() => setSelected(commit)}
              >
                <span className="history-item-msg">
                  {commitTitle(commit.message, commit.shortHash)}
                  {i === 0 && (
                    <span className="history-current">{t("history.currentBadge")}</span>
                  )}
                </span>
                <span className="history-item-meta">
                  {commit.author} · {formatCommitTime(commit.timestamp, language)} ·{" "}
                  <code>{commit.shortHash}</code>
                </span>
              </button>
            ))}
          </div>

          <div className="history-preview">
            {!selected && commits && commits.length > 0 && (
              <p className="history-status">{t("history.selectPrompt")}</p>
            )}
            {selected && (
              <>
                <div className="history-preview-bar">
                  <span className="history-readonly">{t("history.readOnly")}</span>
                </div>
                {previewLoading && (
                  <p className="history-status">{t("history.previewLoading")}</p>
                )}
                {restoreError && <p className="history-status error">{restoreError}</p>}
                {preview !== null && (
                  <pre className="history-preview-content">{preview}</pre>
                )}
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button
            className="primary-btn"
            disabled={preview === null || previewLoading || restoring}
            onClick={() => void restore()}
          >
            {restoring ? t("history.restoring") : t("history.restore")}
          </button>
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
