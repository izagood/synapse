import { useCallback, useEffect, useRef } from "react";
import { useTerminal, TERMINAL_DEFAULT_HEIGHT } from "../../stores/terminal";
import {
  ensureSession,
  disposeSession,
  fitSession,
  focusSession,
} from "./terminalSessions";
import { CloseIcon, PlusIcon } from "../../shared/Icons";
import { useT } from "../../i18n";

/**
 * 내장 터미널 도크 — VS Code식 다중·영속 터미널.
 * - 터미널이 1개 이상이면 항상 마운트하고, 숨길 땐 CSS로만 가린다(언마운트 X →
 *   xterm·PTY 세션이 살아 있어 껐다 켜도 작업이 유지된다).
 * - 상단 핸들로 높이 조절, 탭으로 여러 터미널 전환/추가/닫기.
 */
export function TerminalDock() {
  const terminals = useTerminal((s) => s.terminals);
  const activeId = useTerminal((s) => s.activeId);
  const visible = useTerminal((s) => s.visible);
  const heightPx = useTerminal((s) => s.heightPx);
  const setHeight = useTerminal((s) => s.setHeight);
  const setActive = useTerminal((s) => s.setActive);
  const closeTerminal = useTerminal((s) => s.closeTerminal);
  const newTerminal = useTerminal((s) => s.newTerminal);
  const t = useT();

  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  // 활성 터미널이 보일 때 컨테이너 크기에 맞춰 fit + 포커스.
  useEffect(() => {
    if (visible && activeId) {
      // 레이아웃이 적용된 다음 프레임에 fit.
      const raf = requestAnimationFrame(() => {
        fitSession(activeId);
        focusSession(activeId);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [visible, activeId, heightPx]);

  // 본문 크기 변화(높이 드래그·창 리사이즈)에 활성 터미널을 맞춘다.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (activeId) fitSession(activeId);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId]);

  // 창을 줄이면 상한(뷰포트 비례)도 줄어든다 → 저장된 높이를 새 상한으로 재클램프.
  // setHeight 자체가 clamp하므로 현재 값으로 다시 호출하기만 하면 된다.
  useEffect(() => {
    const onResize = () => setHeight(useTerminal.getState().heightPx);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setHeight]);

  // 목록에서 사라진 터미널의 세션을 정리한다(탭 닫기 = 진짜 종료).
  const prevIds = useRef<string[]>([]);
  useEffect(() => {
    const ids = terminals.map((term) => term.id);
    for (const old of prevIds.current) {
      if (!ids.includes(old)) disposeSession(old);
    }
    prevIds.current = ids;
  }, [terminals]);

  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { startY: e.clientY, startH: heightPx };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.classList.add("resizing-sidebar");
    },
    [heightPx],
  );
  const onHandleMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      // 위로 드래그하면 높이가 커진다.
      setHeight(drag.current.startH + (drag.current.startY - e.clientY));
    },
    [setHeight],
  );
  const onHandleUp = useCallback(() => {
    drag.current = null;
    document.body.classList.remove("resizing-sidebar");
  }, []);

  if (terminals.length === 0) return null;

  return (
    <div
      className={`terminal-dock${visible ? "" : " hidden"}`}
      style={{ height: heightPx }}
    >
      <div
        className="terminal-resize-handle"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onDoubleClick={() => setHeight(TERMINAL_DEFAULT_HEIGHT)}
      />
      <div className="terminal-tabbar">
        <div className="terminal-tabs">
          {terminals.map((term) => (
            <div
              key={term.id}
              className={`terminal-tab${term.id === activeId ? " active" : ""}`}
              role="tab"
              aria-selected={term.id === activeId}
              onClick={() => setActive(term.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTerminal(term.id);
              }}
            >
              <span className="terminal-tab-name">{t("terminal.tabName", { n: term.n })}</span>
              <button
                type="button"
                className="terminal-tab-close"
                title={t("common.close")}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(term.id);
                }}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="terminal-new"
          title={t("terminal.new")}
          onClick={() => newTerminal()}
        >
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="terminal-body" ref={bodyRef}>
        {terminals.map((term) => (
          <TerminalInstance key={term.id} id={term.id} active={term.id === activeId} />
        ))}
      </div>
    </div>
  );
}

/** 터미널 1개의 컨테이너. 세션의 영속 host <div>를 자기 컨테이너로 옮겨 붙인다. */
function TerminalInstance({ id, active }: { id: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const session = ensureSession(id);
    el.appendChild(session.host);
    // 언마운트 시 dispose하지 않는다(패널 토글로는 언마운트되지 않으며, 진짜
    // 종료는 Dock의 목록-diff 정리가 담당). host만 떼어 둔다.
    return () => {
      if (session.host.parentElement === el) el.removeChild(session.host);
    };
  }, [id]);

  return (
    <div className="terminal-instance" ref={ref} style={{ display: active ? "block" : "none" }} />
  );
}
