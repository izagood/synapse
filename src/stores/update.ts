import { create } from "zustand";
import { ipc } from "../ipc/ipc";

// 원클릭 업데이트 (F2): 시작 시 1회 확인 → 상태바 배지 → 클릭 한 번으로
// 다운로드·설치·재시작. 설정 화면에서도 수동 확인 가능.
interface UpdateState {
  current: string;
  /** 설치 가능한 새 버전 (없으면 null) */
  available: string | null;
  checking: boolean;
  installing: boolean;
  checked: boolean;
  error: string | null;

  check(): Promise<void>;
  install(): Promise<void>;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  current: "",
  available: null,
  checking: false,
  installing: false,
  checked: false,
  error: null,

  async check() {
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
      });
    } catch (e) {
      set({ error: String(e), checking: false, checked: true });
    }
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
}));
