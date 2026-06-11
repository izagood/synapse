import { useEffect, useRef, useState } from "react";
import { useAgent } from "../../stores/agent";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import { CloseIcon, PlusIcon, RefreshIcon, SendIcon, StopIcon } from "../../shared/Icons";
import { shortcutLabel } from "../../shared/platform";

const ROLE_LABEL: Record<string, string> = {
  user: "나",
  assistant: "Claude",
};

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
            title="새 대화"
          >
            <PlusIcon size={15} />
          </button>
          <button onClick={onClose} title={`패널 닫기 (${toggleShortcut})`}>
            <CloseIcon size={15} />
          </button>
        </span>
      </div>

      {status && !status.installed ? (
        <div className="agent-setup">
          <p>
            claude CLI를 찾을 수 없습니다. Claude Code를 설치하고 터미널에서{" "}
            <code>claude</code>를 실행해 로그인하면 이 패널에서 바로 쓸 수
            있습니다. Windows에서는 설치 후 새 터미널이나 앱 재시작이 필요할 수
            있습니다.
          </p>
          <div className="agent-setup-actions">
            <button
              className="agent-link"
              onClick={() => void ipc.openExternal("https://claude.com/claude-code")}
            >
              설치 안내 열기
            </button>
            <button
              className="agent-link"
              onClick={() => void useAgent.getState().refreshStatus()}
            >
              <RefreshIcon size={13} /> 다시 확인
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="agent-messages" ref={listRef}>
            {items.length === 0 && (
              <p className="agent-empty">
                이 폴더의 노트를 읽을 수 있는 Claude에게 무엇이든 물어보세요.
              </p>
            )}
            {items.map((item) =>
              item.role === "tool" ? (
                <div key={item.id} className="agent-tool">
                  {item.text}
                </div>
              ) : (
                <div key={item.id} className={`agent-message ${item.role}`}>
                  {ROLE_LABEL[item.role] && (
                    <div className="agent-message-role">{ROLE_LABEL[item.role]}</div>
                  )}
                  <div className="agent-message-text">{item.text}</div>
                </div>
              ),
            )}
            {running && <div className="agent-thinking">생각하는 중…</div>}
          </div>

          <div className="agent-input">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={root ? "Claude에게 보내기 (Enter)" : "폴더를 먼저 여세요"}
              disabled={!root}
              rows={2}
            />
            {running ? (
              <button
                className="agent-send"
                onClick={() => void useAgent.getState().stop()}
                title="응답 중단"
              >
                <StopIcon size={15} />
              </button>
            ) : (
              <button
                className="agent-send"
                onClick={submit}
                disabled={!input.trim() || !root}
                title="보내기 (Enter)"
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
