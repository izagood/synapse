// 터미널 세션 레지스트리 (React 생명주기와 분리).
//
// xterm 인스턴스와 PTY를 모듈 레벨 Map에 보관해, 패널을 껐다 켜도(컴포넌트가
// 숨겨지거나 재마운트돼도) 세션이 유지되게 한다. 각 세션은 자체 host <div>를
// 소유하고 그 안에 xterm이 attach된다 — 컴포넌트는 이 host를 자기 컨테이너로
// 옮겨 붙이기만 한다(re-open 없이 이동 가능, StrictMode/재마운트 안전).

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useTerminal } from "../../stores/terminal";
import { decodeBase64 } from "./ptyDecode";
import { attachImeStabilizer } from "./imeStabilizer";

interface Session {
  term: Terminal;
  fit: FitAddon;
  /** xterm이 attach된 영속 호스트 엘리먼트. 컨테이너 사이를 이동시킨다. */
  host: HTMLDivElement;
  ptyId: string | null;
  /** ptyOpen 진행 Promise — dispose가 끝나길 기다렸다 정리하도록. */
  ready: Promise<void>;
  /** WebKit IME 안정화 해제 함수 (dispose 시 호출). */
  detachIme: () => void;
}

const sessions = new Map<string, Session>();
/** ptyId → 터미널 id (전역 이벤트 라우팅용) */
const byPtyId = new Map<string, string>();

// 전역 PTY 이벤트 라우팅을 단 한 번만 설치한다. ptyOpen 호출 전에 리스너가
// 준비되도록 ensureRouting()을 await한 뒤 ptyOpen 한다(초기 출력 유실 방지).
let routingReady: Promise<void> | null = null;
function ensureRouting(): Promise<void> {
  if (!routingReady) {
    routingReady = (async () => {
      await ipc.onPtyData((p) => {
        const tid = byPtyId.get(p.id);
        if (tid) sessions.get(tid)?.term.write(decodeBase64(p.data));
      });
      await ipc.onPtyExit((eid) => {
        const tid = byPtyId.get(eid);
        // 셸이 종료되면(exit 입력 등) 해당 탭을 닫는다.
        if (tid) useTerminal.getState().closeTerminal(tid);
      });
    })();
  }
  return routingReady;
}

/** 세션을 가져오거나(없으면) 만든다. xterm을 host에 open하고 PTY를 띄운다. */
export function ensureSession(id: string): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const term = new Terminal({
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    allowProposedApi: true,
    // 셸 다크 테마(VS Code 유사).
    theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const host = document.createElement("div");
  host.className = "terminal-host";
  term.open(host);
  // WKWebView에서 한글 조합이 깨지는 xterm 버그 우회 (WebKit에서만 활성화).
  const detachIme = attachImeStabilizer(term);

  const session: Session = { term, fit, host, ptyId: null, ready: Promise.resolve(), detachIme };
  sessions.set(id, session);

  session.ready = (async () => {
    await ensureRouting();
    const root = useWorkspace.getState().root;
    const ptyId = await ipc.ptyOpen(root, term.cols || 80, term.rows || 24);
    session.ptyId = ptyId;
    byPtyId.set(ptyId, id);
    term.onData((d) => void ipc.ptyWrite(ptyId, d));
  })();

  return session;
}

/** 활성 터미널 크기를 컨테이너에 맞추고 PTY에도 반영한다. */
export function fitSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.fit.fit();
    if (s.ptyId) void ipc.ptyResize(s.ptyId, s.term.cols, s.term.rows);
  } catch {
    // 컨테이너가 숨겨지거나 크기가 0이면 fit이 실패할 수 있다 — 무시.
  }
}

export function focusSession(id: string): void {
  sessions.get(id)?.term.focus();
}

/** 세션을 완전히 정리한다(PTY kill + xterm dispose). 탭을 닫을 때만 호출. */
export function disposeSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  void (async () => {
    await s.ready.catch(() => {});
    if (s.ptyId) {
      byPtyId.delete(s.ptyId);
      void ipc.ptyKill(s.ptyId);
    }
    s.detachIme();
    s.term.dispose();
    s.host.remove();
  })();
}
