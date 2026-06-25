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
export const TERMINAL_MAX_HEIGHT = 800;

function loadHeight(): number {
  if (typeof localStorage === "undefined") return TERMINAL_DEFAULT_HEIGHT;
  const v = Number(localStorage.getItem(HEIGHT_KEY));
  return v >= TERMINAL_MIN_HEIGHT && v <= TERMINAL_MAX_HEIGHT ? v : TERMINAL_DEFAULT_HEIGHT;
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
    const clamped = Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, px));
    if (typeof localStorage !== "undefined") localStorage.setItem(HEIGHT_KEY, String(clamped));
    set({ heightPx: clamped });
  },
}));
