import { create } from "zustand";

// 내장 터미널(다중·영속) UI 상태. 실제 xterm 인스턴스/PTY는 React 생명주기와 분리해
// features/terminal/terminalSessions.ts 모듈 레지스트리가 보관한다(패널 토글에도 생존).

export interface TerminalInfo {
  /** 클라이언트 안정 id — 세션 레지스트리 키 & React key */
  id: string;
  /** 탭 표시용 일련번호(닫아도 재사용하지 않음, VS Code식) */
  n: number;
}

const HEIGHT_KEY = "synapse.terminalHeight";
export const TERMINAL_DEFAULT_HEIGHT = 280;
export const TERMINAL_MIN_HEIGHT = 120;
/** 도크가 최대로 커져도 위쪽에 남겨 둘 에디터 최소 가시 영역(탭바+여유). */
export const TERMINAL_MIN_EDITOR_GAP = 160;
/** window를 못 잡는 환경(테스트·SSR) 폴백 뷰포트 높이. */
const FALLBACK_VIEWPORT_HEIGHT = 1000;

/**
 * 도크 높이 상한 — 절대 픽셀이 아니라 뷰포트 비례.
 * 큰 화면에서는 화면 거의 끝까지, 작은 화면에서는 에디터 영역을 남기고 커진다
 * (VS Code 패널 동작). 항상 MIN_HEIGHT 이상을 보장한다.
 */
export function terminalMaxHeight(): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : FALLBACK_VIEWPORT_HEIGHT;
  return Math.max(TERMINAL_MIN_HEIGHT, vh - TERMINAL_MIN_EDITOR_GAP);
}

function loadHeight(): number {
  if (typeof localStorage === "undefined") return TERMINAL_DEFAULT_HEIGHT;
  const v = Number(localStorage.getItem(HEIGHT_KEY));
  return v >= TERMINAL_MIN_HEIGHT && v <= terminalMaxHeight() ? v : TERMINAL_DEFAULT_HEIGHT;
}

let idSeq = 1;
let labelSeq = 1;

interface TerminalState {
  terminals: TerminalInfo[];
  activeId: string | null;
  /** 패널 표시 여부. 숨겨도 터미널 목록/세션은 유지된다(토글로 작업이 사라지지 않게). */
  visible: boolean;
  heightPx: number;

  /** 새 터미널을 만들고 활성화 + 패널 표시. */
  newTerminal: () => void;
  /** 터미널을 닫는다(활성 보정, 마지막이면 패널 숨김). 세션 정리는 Dock이 목록 변화로 감지. */
  closeTerminal: (id: string) => void;
  setActive: (id: string) => void;
  /** 패널 토글. 터미널이 없으면 하나 만들어 켠다. */
  toggle: () => void;
  setHeight: (px: number) => void;
}

export const useTerminal = create<TerminalState>((set, get) => ({
  terminals: [],
  activeId: null,
  visible: false,
  heightPx: loadHeight(),

  newTerminal: () => {
    const term = { id: `term-${idSeq++}`, n: labelSeq++ };
    set((s) => ({
      terminals: [...s.terminals, term],
      activeId: term.id,
      visible: true,
    }));
  },

  closeTerminal: (id) =>
    set((s) => {
      const idx = s.terminals.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const terminals = s.terminals.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        // 닫은 게 활성이면 오른쪽(없으면 왼쪽) 탭으로 이동
        const next = terminals[idx] ?? terminals[idx - 1] ?? null;
        activeId = next?.id ?? null;
      }
      return { terminals, activeId, visible: terminals.length > 0 ? s.visible : false };
    }),

  setActive: (id) => set({ activeId: id }),

  toggle: () => {
    const s = get();
    if (s.terminals.length === 0) {
      s.newTerminal();
      return;
    }
    set({ visible: !s.visible });
  },

  setHeight: (px) => {
    const clamped = Math.min(terminalMaxHeight(), Math.max(TERMINAL_MIN_HEIGHT, px));
    if (typeof localStorage !== "undefined") localStorage.setItem(HEIGHT_KEY, String(clamped));
    set({ heightPx: clamped });
  },
}));
