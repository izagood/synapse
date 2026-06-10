import { useEffect, useState } from "react";
import { badgeOf, useSync } from "../../stores/sync";
import { useWorkspace } from "../../stores/workspace";
import { LoginModal } from "./LoginModal";

const STATUS_POLL_MS = 15_000;
const AUTO_SYNC_MS = 5 * 60_000;

const BADGE_LABEL = {
  synced: "✅ 동기화됨",
  pending: "🔄 동기화 필요",
  conflict: "⚠️ 충돌",
  none: "",
} as const;

function PublishForm({ root }: { root: string }) {
  const publish = useSync((s) => s.publish);
  const syncing = useSync((s) => s.syncing);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(root.split("/").pop() ?? "notes");
  const [isPrivate, setIsPrivate] = useState(true);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="이 폴더를 GitHub 리포지토리로 게시">
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

export function SyncBar() {
  const root = useWorkspace((s) => s.root);
  const { login, status, syncing, error, init, startLogin, logout, refreshStatus, syncNow } =
    useSync();

  // 로그인 상태 1회 로드 + 상태 폴링 + 주기 자동 동기화 (FR-4.3)
  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!root) return;
    void refreshStatus(root);
    const statusTimer = setInterval(() => void refreshStatus(root), STATUS_POLL_MS);
    const autoTimer = setInterval(() => {
      const s = useSync.getState();
      if (s.login && s.status?.state === "pending" && !s.syncing) {
        void s.syncNow(root);
      }
    }, AUTO_SYNC_MS);
    return () => {
      clearInterval(statusTimer);
      clearInterval(autoTimer);
    };
  }, [root, refreshStatus]);

  if (!root) return null;
  const badge = badgeOf(status);
  const needsSetup = status?.state === "noRepo" || status?.state === "noRemote";

  return (
    <>
      <ConflictPanel root={root} />
      <footer className="sync-bar">
        <span className="sync-state">
          {status?.state === "noGit"
            ? "git이 설치되어 있지 않습니다"
            : BADGE_LABEL[badge]}
          {error && <span className="error"> {error}</span>}
        </span>
        <span className="sync-actions">
          {login ? (
            <>
              {needsSetup && <PublishForm root={root} />}
              {!needsSetup && status?.state !== "noGit" && (
                <button disabled={syncing} onClick={() => void syncNow(root)}>
                  {syncing ? "동기화 중…" : "동기화"}
                </button>
              )}
              <span className="sync-user" title="GitHub 계정">
                {login}
              </span>
              <button onClick={() => void logout()} title="로그아웃">
                로그아웃
              </button>
            </>
          ) : (
            <button onClick={() => void startLogin()}>GitHub 로그인</button>
          )}
        </span>
      </footer>
      <LoginModal />
    </>
  );
}
