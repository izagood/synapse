import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { CloseIcon } from "../../shared/Icons";
import { useT } from "../../i18n";
import { decodeBase64 } from "./ptyDecode";

/**
 * 내장 터미널 패널. xterm.js를 실제 PTY(백엔드)에 연결한다.
 * 워크스페이스 루트가 cwd가 되고, 자식 env에 브리지 접속 정보가 주입돼 있어
 * 여기서 `claude`/`codex`를 실행하면 Synapse MCP로 현재 노트를 받아 쓸 수 있다.
 */
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 마운트 시점의 루트로 PTY를 연다. 루트가 바뀌면 effect가 재실행돼 새 터미널을 띄운다.
  const root = useWorkspace((s) => s.root);
  const t = useT();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let ptyId: string | null = null;
    const unlisteners: Array<() => void> = [];

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      cursorBlink: true,
      // 패널 배경과 어울리는 어두운 테마(터미널은 보통 다크).
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    void (async () => {
      const id = await ipc.ptyOpen(root, term.cols, term.rows);
      if (disposed) {
        // 열리는 사이에 언마운트됐으면 즉시 정리.
        void ipc.ptyKill(id);
        return;
      }
      ptyId = id;
      term.onData((data) => void ipc.ptyWrite(id, data));
      unlisteners.push(
        await ipc.onPtyData((p) => {
          if (p.id === id) term.write(decodeBase64(p.data));
        }),
      );
      unlisteners.push(
        await ipc.onPtyExit((exitId) => {
          if (exitId === id) term.writeln("\r\n\x1b[90m[프로세스 종료됨]\x1b[0m");
        }),
      );
    })();

    // 패널 크기가 바뀌면 PTY 크기도 맞춘다.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ptyId) void ipc.ptyResize(ptyId, term.cols, term.rows);
      } catch {
        // 패널이 막 사라질 때 0 크기로 fit이 실패할 수 있다 — 무시.
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      unlisteners.forEach((u) => u());
      if (ptyId) void ipc.ptyKill(ptyId);
      term.dispose();
    };
  }, [root]);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">{t("terminal.title")}</span>
        <button
          type="button"
          className="terminal-panel-close"
          onClick={onClose}
          title={t("common.close")}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="terminal-panel-body" ref={containerRef} />
    </div>
  );
}
