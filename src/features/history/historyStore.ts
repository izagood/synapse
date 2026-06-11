import { create } from "zustand";

/**
 * 파일 히스토리 모달 (FR-4.7)의 열림 상태. 진입점(탭/사이드바 컨텍스트 메뉴)이
 * 어디든 한 곳에서 모달을 띄우도록 전역 스토어로 분리한다.
 */
interface HistoryUiState {
  /** 히스토리를 보고 있는 파일의 절대 경로. null이면 닫힘 */
  path: string | null;
  open(path: string): void;
  close(): void;
}

export const useHistoryUi = create<HistoryUiState>((set) => ({
  path: null,
  open: (path) => set({ path }),
  close: () => set({ path: null }),
}));
