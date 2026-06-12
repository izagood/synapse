import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { ConflictChoice, DeviceCode, SyncStatus } from "../ipc/types";
import { syncCommitMessage } from "../features/sync/commitMessage";
import { IPC_TIMEOUT_MS, withTimeout } from "../features/sync/guard";
import { useWorkspace } from "./workspace";
import { translate } from "../i18n";
import { useSettings } from "./settings";

// FR-4.8: 엔진 상태는 세분화되어 있지만 UI는 3가지로 접는다
export type SyncBadge = "synced" | "pending" | "conflict" | "none";

export function badgeOf(status: SyncStatus | null): SyncBadge {
  switch (status?.state) {
    case "synced":
      return "synced";
    case "pending":
      return "pending";
    case "conflict":
      return "conflict";
    default:
      return "none";
  }
}

interface SyncStoreState {
  login: string | null;
  status: SyncStatus | null;
  device: DeviceCode | null;
  loginError: string | null;
  syncing: boolean;
  error: string | null;
  /** 자동 동기화 백오프용: 연속 실패 횟수 (성공 시 0으로) */
  failures: number;
  /** 마지막 동기화 시도 시각 (epoch ms) */
  lastAttemptAt: number | null;

  init(): Promise<void>;
  /** 워크스페이스 전환 시 이전 폴더의 상태·에러를 비운다 */
  resetWorkspace(): void;
  /** 푸터 오류 패널을 닫는다 (사용자가 확인/해결한 뒤) */
  dismissError(): void;
  startLogin(): Promise<void>;
  /** Device Flow 폴링 루프 — 성공/실패 시 스스로 종료 */
  pollLogin(): Promise<void>;
  cancelLogin(): void;
  logout(): Promise<void>;

  refreshStatus(root: string): Promise<void>;
  syncNow(root: string): Promise<void>;
  resolveConflict(root: string, choice: ConflictChoice): Promise<void>;
  publish(root: string, name: string, isPrivate: boolean): Promise<void>;
}

export const useSync = create<SyncStoreState>((set, get) => ({
  login: null,
  status: null,
  device: null,
  loginError: null,
  syncing: false,
  error: null,
  failures: 0,
  lastAttemptAt: null,

  async init() {
    try {
      set({ login: await ipc.githubUser() });
    } catch {
      set({ login: null });
    }
  },

  resetWorkspace() {
    set({ status: null, error: null, syncing: false, failures: 0, lastAttemptAt: null });
  },

  dismissError() {
    set({ error: null });
  },

  async startLogin() {
    set({ loginError: null });
    try {
      const device = await ipc.githubLoginStart();
      set({ device });
      void get().pollLogin();
    } catch (e) {
      set({ loginError: String(e) });
    }
  },

  async pollLogin() {
    const device = get().device;
    if (!device) return;
    let intervalMs = Math.max(device.interval, 0.01) * 1000;
    // device 코드 만료(15분)보다 넉넉히 길게는 돌지 않는다
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (get().device !== device) return; // 취소되었거나 새 로그인 시작됨
      try {
        const result = await ipc.githubLoginPoll();
        if (result.status === "ok") {
          set({ login: result.login, device: null });
          return;
        }
        if (result.status === "failed") {
          set({ loginError: result.message, device: null });
          return;
        }
        if (result.status === "slowDown") intervalMs += 5000;
      } catch (e) {
        set({ loginError: String(e), device: null });
        return;
      }
    }
    set({
      loginError: translate(
        useSettings.getState().settings.appearance.language,
        "sync.loginTimeout",
      ),
      device: null,
    });
  },

  cancelLogin() {
    set({ device: null });
  },

  async logout() {
    await ipc.githubLogout();
    set({ login: null });
  },

  async refreshStatus(root) {
    try {
      set({ status: await ipc.syncStatus(root) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async syncNow(root) {
    if (get().syncing) return;
    set({ syncing: true, error: null, lastAttemptAt: Date.now() });
    try {
      // 미저장 편집을 먼저 CRDT에 기록해 이번 커밋에 싣는다
      await useWorkspace.getState().flushDirty();
      const language = useSettings.getState().settings.appearance.language;
      const syncLabel = translate(language, "sync.timeoutLabelSync");
      // 워치독: 백엔드가 응답하지 못해도 syncing이 영구히 잠기지 않게 한다
      set({
        status: await withTimeout(
          ipc.syncNow(root, syncCommitMessage(new Date(), language)),
          IPC_TIMEOUT_MS,
          syncLabel,
          translate(language, "sync.timeoutMessage", {
            label: syncLabel,
            seconds: Math.round(IPC_TIMEOUT_MS / 1000),
          }),
        ),
      });
      // pull로 받은 원격 변경을 열린 에디터에 라이브 반영
      await useWorkspace.getState().reloadAfterSync();
      set({ failures: 0 });
    } catch (e) {
      set({ error: String(e), failures: get().failures + 1 });
    } finally {
      set({ syncing: false });
    }
  },

  async resolveConflict(root, choice) {
    set({ syncing: true, error: null });
    try {
      const language = useSettings.getState().settings.appearance.language;
      const label = translate(language, "sync.timeoutLabelConflict");
      set({
        status: await withTimeout(
          ipc.resolveConflict(root, choice),
          IPC_TIMEOUT_MS,
          label,
          translate(language, "sync.timeoutMessage", {
            label,
            seconds: Math.round(IPC_TIMEOUT_MS / 1000),
          }),
        ),
      });
      await useWorkspace.getState().reloadAfterSync();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ syncing: false });
    }
  },

  async publish(root, name, isPrivate) {
    set({ syncing: true, error: null });
    try {
      const language = useSettings.getState().settings.appearance.language;
      const label = translate(language, "sync.timeoutLabelPublish");
      set({
        status: await withTimeout(
          ipc.publishWorkspace(root, name, isPrivate),
          IPC_TIMEOUT_MS,
          label,
          translate(language, "sync.timeoutMessage", {
            label,
            seconds: Math.round(IPC_TIMEOUT_MS / 1000),
          }),
        ),
      });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ syncing: false });
    }
  },
}));
