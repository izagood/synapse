import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { ConflictChoice, DeviceCode, SyncStatus } from "../ipc/types";
import { syncCommitMessage } from "../features/sync/commitMessage";
import { useWorkspace } from "./workspace";

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

  init(): Promise<void>;
  /** 워크스페이스 전환 시 이전 폴더의 상태·에러를 비운다 */
  resetWorkspace(): void;
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

  async init() {
    try {
      set({ login: await ipc.githubUser() });
    } catch {
      set({ login: null });
    }
  },

  resetWorkspace() {
    set({ status: null, error: null, syncing: false });
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
    set({ loginError: "로그인 시간이 초과되었습니다", device: null });
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
    set({ syncing: true, error: null });
    try {
      // 미저장 편집을 먼저 CRDT에 기록해 이번 커밋에 싣는다
      await useWorkspace.getState().flushDirty();
      set({ status: await ipc.syncNow(root, syncCommitMessage()) });
      // pull로 받은 원격 변경을 열린 에디터에 라이브 반영
      await useWorkspace.getState().reloadAfterSync();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ syncing: false });
    }
  },

  async resolveConflict(root, choice) {
    set({ syncing: true, error: null });
    try {
      set({ status: await ipc.resolveConflict(root, choice) });
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
      set({ status: await ipc.publishWorkspace(root, name, isPrivate) });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ syncing: false });
    }
  },
}));
