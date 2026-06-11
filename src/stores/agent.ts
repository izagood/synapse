import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { AgentEvent, AgentStatus } from "../ipc/types";

// PLAN-v0.4 Phase 1: 워크스페이스를 cwd로 claude CLI 한 턴씩 실행하는 채팅.
// 대화 내역은 메모리에만 두고, 세션 ID만 워크스페이스별로 localStorage에
// 남겨 앱을 다시 열어도 --resume으로 맥락이 이어지게 한다.

export type ChatRole = "user" | "assistant" | "tool" | "error" | "info";

export interface ChatItem {
  id: number;
  role: ChatRole;
  text: string;
}

const sessionKey = (root: string) => `synapse.agentSession:${root}`;

function loadSessionId(root: string): string | null {
  try {
    return globalThis.localStorage?.getItem(sessionKey(root)) ?? null;
  } catch {
    return null;
  }
}

function storeSessionId(root: string, id: string | null) {
  try {
    if (id === null) globalThis.localStorage?.removeItem(sessionKey(root));
    else globalThis.localStorage?.setItem(sessionKey(root), id);
  } catch {
    // localStorage가 없는 환경(테스트)에서는 메모리 상태만 쓴다
  }
}

function newRunId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

let nextItemId = 1;
let subscribed = false;

interface AgentStoreState {
  status: AgentStatus | null;
  items: ChatItem[];
  running: boolean;
  /** 진행 중인 요청 ID — 다른 창/이전 요청의 이벤트를 걸러낸다 */
  runId: string | null;
  sessionId: string | null;
  root: string | null;

  /** CLI 상태 조회 + 이벤트 구독 + 워크스페이스 세션 로드 */
  init(root: string): Promise<void>;
  refreshStatus(): Promise<void>;
  send(root: string, prompt: string): Promise<void>;
  stop(): Promise<void>;
  /** 세션을 버리고 빈 대화로 시작 */
  newConversation(): void;
  applyEvent(runId: string, event: AgentEvent): void;
}

export const useAgent = create<AgentStoreState>((set, get) => ({
  status: null,
  items: [],
  running: false,
  runId: null,
  sessionId: null,
  root: null,

  async init(root) {
    if (!subscribed) {
      subscribed = true;
      void ipc.onAgentEvent((p) => get().applyEvent(p.runId, p.event));
    }
    // 워크스페이스가 바뀌면 이전 대화는 비운다
    if (get().root !== root) {
      set({ root, items: [], runId: null, running: false, sessionId: loadSessionId(root) });
    }
    await get().refreshStatus();
  },

  async refreshStatus() {
    try {
      set({ status: await ipc.agentStatus() });
    } catch {
      set({ status: { installed: false, path: null } });
    }
  },

  async send(root, prompt) {
    if (get().running) return;
    const runId = newRunId();
    const sessionId = get().sessionId;
    set((s) => ({
      root,
      runId,
      running: true,
      items: [...s.items, { id: nextItemId++, role: "user", text: prompt }],
    }));
    try {
      await ipc.agentSend(root, prompt, sessionId, runId);
    } catch (e) {
      set((s) => ({
        running: false,
        items: [...s.items, { id: nextItemId++, role: "error", text: String(e) }],
      }));
    }
  },

  async stop() {
    if (!get().running) return;
    try {
      await ipc.agentStop();
    } catch (e) {
      set((s) => ({
        items: [...s.items, { id: nextItemId++, role: "error", text: String(e) }],
      }));
    }
  },

  newConversation() {
    if (get().running) return;
    const root = get().root;
    if (root) storeSessionId(root, null);
    set({ items: [], sessionId: null, runId: null });
  },

  applyEvent(runId, event) {
    if (runId !== get().runId) return;
    const push = (role: ChatRole, text: string) =>
      set((s) => ({ items: [...s.items, { id: nextItemId++, role, text }] }));

    switch (event.kind) {
      case "started": {
        // 중단되더라도 세션이 이어지도록 시작 시점에 바로 저장한다
        const root = get().root;
        if (root) storeSessionId(root, event.sessionId);
        set({ sessionId: event.sessionId });
        break;
      }
      case "text":
        push("assistant", event.text);
        break;
      case "toolUse":
        push("tool", event.detail ? `${event.name} · ${event.detail}` : event.name);
        break;
      case "completed": {
        const root = get().root;
        if (root) storeSessionId(root, event.sessionId);
        set({ running: false, sessionId: event.sessionId });
        if (!event.ok) push("error", event.result);
        break;
      }
      case "failed":
        set({ running: false });
        push("error", event.message);
        break;
      case "aborted":
        set({ running: false });
        push("info", "응답을 중단했습니다");
        break;
    }
  },
}));
