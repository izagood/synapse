import { useEffect, useRef, useState } from "react";
import { useAgent } from "../../stores/agent";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import { CloseIcon, PlusIcon, RefreshIcon, SendIcon, StopIcon } from "../../shared/Icons";
import { shortcutLabel } from "../../shared/platform";
import { useT } from "../../i18n";

// PLAN-v0.4 Phase 1: 워크스페이스를 컨텍스트로 claude와 대화하는 우측 패널.
// 읽기 전용 도구만 허용된 헤드리스 CLI 한 턴씩 실행한다.
export function AgentPanel({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const status = useAgent((s) => s.status);
  const items = useAgent((s) => s.items);
  const running = useAgent((s) => s.running);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const toggleShortcut = shortcutLabel(["Shift", "Mod", "A"]);
  const t = useT();
  const roleLabel: Record<string, string> = {
    user: t("agent.roleUser"),
    assistant: t("agent.roleAssistant"),
  };

  useEffect(() => {
    if (root) void useAgent.getState().init(root);
  }, [root]);

  // 새 메시지가 오면 맨 아래로
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, running]);

  const submit = () => {
    const prompt = input.trim();
    if (!prompt || !root || running) return;
    setInput("");
    void useAgent.getState().send(root, prompt);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside className="agent-panel">
      <div className="agent-header">
        <span className="agent-title">Claude</span>
        <span className="agent-actions">
          <button
            onClick={() => useAgent.getState().newConversation()}
            disabled={running}
            title={t("agent.newConversation")}
          >
            <PlusIcon size={15} />
          </button>
          <button onClick={onClose} title={t("agent.closePanel", { shortcut: toggleShortcut })}>
            <CloseIcon size={15} />
          </button>
        </span>
      </div>

      {status && !status.installed ? (
        <div className="agent-setup">
          <p>
            {t("agent.setup")}
          </p>
          <div className="agent-setup-actions">
            <button
              className="agent-link"
              onClick={() => void ipc.openExternal("https://claude.com/claude-code")}
            >
              {t("agent.openInstallGuide")}
            </button>
            <button
              className="agent-link"
              onClick={() => void useAgent.getState().refreshStatus()}
            >
              <RefreshIcon size={13} /> {t("common.retry")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="agent-messages" ref={listRef}>
            {items.length === 0 && (
              <p className="agent-empty">
                {t("agent.empty")}
              </p>
            )}
            {items.map((item) =>
              item.role === "tool" ? (
                <div key={item.id} className="agent-tool">
                  {item.text}
                </div>
              ) : (
                <div key={item.id} className={`agent-message ${item.role}`}>
                  {roleLabel[item.role] && (
                    <div className="agent-message-role">{roleLabel[item.role]}</div>
                  )}
                  <div className="agent-message-text">{item.text}</div>
                </div>
              ),
            )}
            {running && <div className="agent-thinking">{t("agent.thinking")}</div>}
          </div>

          <div className="agent-input">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                root ? t("agent.sendPlaceholder") : t("agent.openFolderPlaceholder")
              }
              disabled={!root}
              rows={2}
            />
            {running ? (
              <button
                className="agent-send"
                onClick={() => void useAgent.getState().stop()}
                title={t("agent.stopResponse")}
              >
                <StopIcon size={15} />
              </button>
            ) : (
              <button
                className="agent-send"
                onClick={submit}
                disabled={!input.trim() || !root}
                title={t("agent.send")}
              >
                <SendIcon size={15} />
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
