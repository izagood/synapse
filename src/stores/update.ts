import { create } from "zustand";
import { ipc } from "../ipc/ipc";

// 원클릭 업데이트 (F2): 시작·창 포커스 시 자동 확인 → 토스트 알림 + 상태바 배지
// → 클릭 한 번으로 다운로드·설치·재시작. 설정 화면에서도 수동 확인 가능.

/** 창 포커스로 돌아왔을 때 이 시간이 지났으면 다시 확인한다 */
export const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4시간

interface UpdateState {
  current: string;
  /** 설치 가능한 새 버전 (없으면 null) */
  available: string | null;
  /** "나중에"를 눌러 알림을 닫은 버전 — 같은 버전은 토스트를 다시 띄우지 않는다 */
  dismissedVersion: string | null;
  checking: boolean;
  installing: boolean;
  checked: boolean;
  lastCheckedAt: number | null;
  error: string | null;

  check(now?: number): Promise<void>;
  /** 마지막 확인 후 UPDATE_RECHECK_INTERVAL_MS가 지났을 때만 다시 확인 */
  recheckIfStale(now?: number): Promise<void>;
  install(): Promise<void>;
  dismiss(): void;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  current: "",
  available: null,
  dismissedVersion: null,
  checking: false,
  installing: false,
  checked: false,
  lastCheckedAt: null,
  error: null,

  async check(now = Date.now()) {
    if (get().checking) return;
    set({ checking: true, error: null });
    try {
      const [current, update] = await Promise.all([
        ipc.appVersion(),
        ipc.checkUpdate(),
      ]);
      set({
        current,
        available: update?.version ?? null,
        checking: false,
        checked: true,
        lastCheckedAt: now,
      });
    } catch (e) {
      set({ error: String(e), checking: false, checked: true, lastCheckedAt: now });
    }
  },

  async recheckIfStale(now = Date.now()) {
    const last = get().lastCheckedAt;
    if (last !== null && now - last < UPDATE_RECHECK_INTERVAL_MS) return;
    await get().check(now);
  },

  async install() {
    if (get().installing || !get().available) return;
    set({ installing: true, error: null });
    try {
      await ipc.installUpdate(); // 성공하면 앱이 재시작되어 여기로 돌아오지 않는다
    } catch (e) {
      set({ error: String(e), installing: false });
    }
  },

  dismiss() {
    set({ dismissedVersion: get().available });
  },
}));
