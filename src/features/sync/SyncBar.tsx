import { useEffect, useState } from "react";
import { badgeOf, useSync } from "../../stores/sync";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { shouldAutoSync, shouldSyncOnOpen } from "./guard";
import { LoginModal } from "./LoginModal";
import { UpdateBadge } from "../update/UpdateBadge";
import {
  AlertIcon,
  CheckIcon,
  GitHubIcon,
  LogOutIcon,
  RefreshIcon,
} from "../../shared/Icons";
import { useT } from "../../i18n";

const STATUS_POLL_MS = 15_000;

function PublishForm({ root }: { root: string }) {
  const publish = useSync((s) => s.publish);
  const syncing = useSync((s) => s.syncing);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(root.split("/").pop() ?? "notes");
  const [isPrivate, setIsPrivate] = useState(true);
  const t = useT();

  if (!open) {
    return (
      <button className="statusbar-btn" onClick={() => setOpen(true)} title={t("sync.publishTitle")}>
        {t("sync.publishToGitHub")}
      </button>
    );
  }
  return (
    <span className="publish-form">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("sync.repoNamePlaceholder")}
      />
      <label>
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(e) => setIsPrivate(e.target.checked)}
        />
        {t("sync.private")}
      </label>
      <button
        disabled={syncing || !name.trim()}
        onClick={() =>
          void publish(root, name.trim(), isPrivate).then(
            () => setOpen(false),
            () => undefined,
          )
        }
      >
        {t("sync.publish")}
      </button>
      <button onClick={() => setOpen(false)}>{t("common.cancel")}</button>
    </span>
  );
}

function ConflictPanel({ root }: { root: string }) {
  const status = useSync((s) => s.status);
  const resolveConflict = useSync((s) => s.resolveConflict);
  const syncing = useSync((s) => s.syncing);
  const t = useT();

  if (status?.state !== "conflict") return null;

  return (
    <div className="conflict-panel">
      <div>
        <strong>{t("sync.conflictTitle")}</strong>{" "}
        <span className="conflict-files">{status.conflictFiles.join(", ")}</span>
      </div>
      <div className="conflict-actions">
        <button disabled={syncing} onClick={() => void resolveConflict(root, "keepMine")}>
          {t("sync.keepMine")}
        </button>
        <button disabled={syncing} onClick={() => void resolveConflict(root, "keepRemote")}>
          {t("sync.keepRemote")}
        </button>
        <button disabled={syncing} onClick={() => void resolveConflict(root, "keepBoth")}>
          {t("sync.keepBoth")}
        </button>
      </div>
    </div>
  );
}

/**
 * 동기화/게시 오류를 푸터 위에 펼쳐 보여 준다. 기존엔 푸터에 한 줄로
 * 잘려 나와 전문 확인도, 재시도도 어려웠다 — 전문 표시 + 다시 시도/복사/닫기.
 */
function SyncErrorPanel({ root }: { root: string }) {
  const error = useSync((s) => s.error);
  const syncing = useSync((s) => s.syncing);
  const syncNow = useSync((s) => s.syncNow);
  const dismissError = useSync((s) => s.dismissError);
  const t = useT();

  if (!error) return null;

  return (
    <div className="sync-error-panel" role="alert">
      <div className="sync-error-head">
        <span className="sync-error-title">
          <AlertIcon size={14} /> {t("sync.errorTitle")}
        </span>
        <div className="sync-error-actions">
          <button disabled={syncing} onClick={() => void syncNow(root)}>
            {t("sync.retry")}
          </button>
          <button onClick={() => void navigator.clipboard?.writeText(error)}>
            {t("sync.copyError")}
          </button>
          <button onClick={() => dismissError()}>{t("common.close")}</button>
        </div>
      </div>
      <pre className="sync-error-detail">{error}</pre>
    </div>
  );
}

function SyncStateIndicator({ root }: { root: string }) {
  const status = useSync((s) => s.status);
  const syncing = useSync((s) => s.syncing);
  const syncNow = useSync((s) => s.syncNow);
  const badge = badgeOf(status);
  const t = useT();

  if (status?.state === "noGit") {
    return <span className="sync-state">{t("sync.noGit")}</span>;
  }
  if (badge === "none") return null;

  // 클릭하면 즉시 동기화. 진행 중엔 아이콘 회전 (F5)
  return (
    <button
      className={`sync-indicator state-${syncing ? "syncing" : badge}`}
      onClick={() => void syncNow(root)}
      disabled={syncing}
      title={t("sync.syncNow")}
    >
      <span className={`sync-icon${syncing ? " spin" : ""}`}>
        {syncing ? (
          <RefreshIcon size={13} />
        ) : badge === "synced" ? (
          <CheckIcon size={13} />
        ) : badge === "conflict" ? (
          <AlertIcon size={13} />
        ) : (
          <RefreshIcon size={13} />
        )}
      </span>
      <span className="sync-label">
        {syncing
          ? t("sync.syncing")
          : badge === "synced"
            ? t("sync.synced")
            : badge === "conflict"
              ? t("sync.conflict")
              : t("sync.pending")}
      </span>
    </button>
  );
}

export function SyncBar() {
  const root = useWorkspace((s) => s.root);
  const { login, status, init, startLogin, logout, refreshStatus } = useSync();
  const autoSync = useSettings((s) => s.settings.sync.auto);
  const intervalMinutes = useSettings((s) => s.settings.sync.intervalMinutes);
  const t = useT();

  useEffect(() => {
    void init();
  }, [init]);

  // 상태 폴링 + (켜져 있으면) 주기 자동 동기화 (FR-4.3)
  useEffect(() => {
    if (!root) return;
    // 워크스페이스가 바뀌면 이전 폴더의 상태·에러는 무효 — 비우고 새로 조회
    useSync.getState().resetWorkspace();
    void refreshStatus(root);
    const statusTimer = setInterval(() => void refreshStatus(root), STATUS_POLL_MS);
    const autoIntervalMs = Math.max(intervalMinutes, 1) * 60_000;
    const autoTimer = autoSync
      ? setInterval(() => {
          const s = useSync.getState();
          // pending: 내 변경 push. synced: 원격 변경 pull(준실시간 협업).
          const state = s.status?.state;
          if (!s.login || s.syncing || !(state === "pending" || state === "synced")) return;
          // 연속 실패 시 지수 백오프 — 네트워크가 나쁠 때 매 틱 재시도하지 않는다
          if (!shouldAutoSync(Date.now(), s.lastAttemptAt, autoIntervalMs, s.failures)) return;
          void s.syncNow(root);
        }, autoIntervalMs)
      : undefined;
    return () => {
      clearInterval(statusTimer);
      if (autoTimer) clearInterval(autoTimer);
    };
  }, [root, refreshStatus, autoSync, intervalMinutes]);

  // 폴더를 열거나 로그인하면 곧바로 한 번 pull(동기화)해서 로컬을 원격과
  // 맞춘다 — 이후 커밋을 push 할 때 non-fast-forward로 거부되는 걸 예방한다.
  useEffect(() => {
    if (!root || !login) return;
    let cancelled = false;
    void refreshStatus(root).then(() => {
      if (cancelled) return;
      const s = useSync.getState();
      if (shouldSyncOnOpen(Boolean(s.login), s.status?.state, s.syncing)) {
        void s.syncNow(root);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [root, login, refreshStatus]);

  if (!root) return null;
  const needsSetup = status?.state === "noRepo" || status?.state === "noRemote";

  return (
    <>
      <ConflictPanel root={root} />
      <SyncErrorPanel root={root} />
      <footer className="status-bar">
        <span className="status-left">
          {login && needsSetup && <PublishForm root={root} />}
        </span>
        <span className="status-right">
          {login && !needsSetup && <SyncStateIndicator root={root} />}
          <UpdateBadge />
          {login ? (
            <>
              <span className="sync-user" title={t("sync.accountTitle")}>
                <GitHubIcon size={13} /> {login}
              </span>
              <button className="statusbar-icon-btn" onClick={() => void logout()} title={t("sync.logout")}>
                <LogOutIcon size={13} />
              </button>
            </>
          ) : (
            <button className="statusbar-btn" onClick={() => void startLogin()}>
              <GitHubIcon size={13} /> {t("sync.login")}
            </button>
          )}
        </span>
      </footer>
      <LoginModal />
    </>
  );
}
