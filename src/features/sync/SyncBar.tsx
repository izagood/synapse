import { useEffect, useState } from "react";
import { badgeOf, useSync } from "../../stores/sync";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { shouldAutoSync } from "./guard";
import { LoginModal } from "./LoginModal";
import { UpdateBadge } from "../update/UpdateBadge";
import {
  AlertIcon,
  CheckIcon,
  GitHubIcon,
  LogOutIcon,
  RefreshIcon,
} from "../../shared/Icons";

const STATUS_POLL_MS = 15_000;

function PublishForm({ root }: { root: string }) {
  const publish = useSync((s) => s.publish);
  const syncing = useSync((s) => s.syncing);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(root.split("/").pop() ?? "notes");
  const [isPrivate, setIsPrivate] = useState(true);

  if (!open) {
    return (
      <button className="statusbar-btn" onClick={() => setOpen(true)} title="이 폴더를 GitHub 리포지토리로 게시">
        GitHub에 게시
      </button>
    );
  }
  return (
    <span className="publish-form">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="리포지토리 이름"
      />
      <label>
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(e) => setIsPrivate(e.target.checked)}
        />
        비공개
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
        게시
      </button>
      <button onClick={() => setOpen(false)}>취소</button>
    </span>
  );
}

function ConflictPanel({ root }: { root: string }) {
  const status = useSync((s) => s.status);
  const resolveConflict = useSync((s) => s.resolveConflict);
  const syncing = useSync((s) => s.syncing);

  if (status?.state !== "conflict") return null;

  return (
    <div className="conflict-panel">
      <div>
        <strong>다른 기기의 변경과 충돌했습니다.</strong>{" "}
        <span className="conflict-files">{status.conflictFiles.join(", ")}</span>
      </div>
      <div className="conflict-actions">
        <button disabled={syncing} onClick={() => void resolveConflict(root, "keepMine")}>
          내 버전 유지
        </button>
        <button disabled={syncing} onClick={() => void resolveConflict(root, "keepRemote")}>
          원격 버전 가져오기
        </button>
        <button disabled={syncing} onClick={() => void resolveConflict(root, "keepBoth")}>
          둘 다 보존
        </button>
      </div>
    </div>
  );
}

function SyncStateIndicator({ root }: { root: string }) {
  const status = useSync((s) => s.status);
  const syncing = useSync((s) => s.syncing);
  const syncNow = useSync((s) => s.syncNow);
  const badge = badgeOf(status);

  if (status?.state === "noGit") {
    return <span className="sync-state">git이 설치되어 있지 않습니다</span>;
  }
  if (badge === "none") return null;

  // 클릭하면 즉시 동기화. 진행 중엔 아이콘 회전 (F5)
  return (
    <button
      className={`sync-indicator state-${syncing ? "syncing" : badge}`}
      onClick={() => void syncNow(root)}
      disabled={syncing}
      title="지금 동기화"
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
          ? "동기화 중…"
          : badge === "synced"
            ? "동기화됨"
            : badge === "conflict"
              ? "충돌"
              : "동기화 필요"}
      </span>
    </button>
  );
}

export function SyncBar() {
  const root = useWorkspace((s) => s.root);
  const { login, status, error, init, startLogin, logout, refreshStatus } = useSync();
  const autoSync = useSettings((s) => s.settings.sync.auto);
  const intervalMinutes = useSettings((s) => s.settings.sync.intervalMinutes);

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

  if (!root) return null;
  const needsSetup = status?.state === "noRepo" || status?.state === "noRemote";

  return (
    <>
      <ConflictPanel root={root} />
      <footer className="status-bar">
        <span className="status-left">
          {login && needsSetup && <PublishForm root={root} />}
          {error && <span className="error status-error">{error}</span>}
        </span>
        <span className="status-right">
          {login && !needsSetup && <SyncStateIndicator root={root} />}
          <UpdateBadge />
          {login ? (
            <>
              <span className="sync-user" title="GitHub 계정">
                <GitHubIcon size={13} /> {login}
              </span>
              <button className="statusbar-icon-btn" onClick={() => void logout()} title="로그아웃">
                <LogOutIcon size={13} />
              </button>
            </>
          ) : (
            <button className="statusbar-btn" onClick={() => void startLogin()}>
              <GitHubIcon size={13} /> GitHub 로그인
            </button>
          )}
        </span>
      </footer>
      <LoginModal />
    </>
  );
}
