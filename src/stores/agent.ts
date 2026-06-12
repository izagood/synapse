import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { AgentEvent, AgentStatus } from "../ipc/types";
import { translate } from "../i18n";
import { useSettings } from "./settings";
import { useWorkspace } from "./workspace";
import { buildAgentPrompt } from "./agentContext";
import { buildAskNotesPrompt, sourceNotesFrom, type SourceNote } from "./askNotes";

// PLAN-v0.4 Phase 1: 워크스페이스를 cwd로 claude CLI 한 턴씩 실행하는 채팅.
// 대화 내역은 메모리에만 두고, 세션 ID만 워크스페이스별로 localStorage에
// 남겨 앱을 다시 열어도 --resume으로 맥락이 이어지게 한다.

export type ChatRole = "user" | "assistant" | "tool" | "error" | "info";

export interface ChatItem {
  id: number;
  role: ChatRole;
  text: string;
  /** "내 노트에게 묻기" 답변에 쓰인 출처 노트 (assistant 항목에만, 클릭 시 열기) */
  sources?: SourceNote[];
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
  /** "내 노트에게 묻기" 모드: 질문마다 관련 노트를 retrieval해 근거로 첨부한다 (2-C) */
  askNotes: boolean;
  /** 현재 진행 중 요청의 retrieval 출처 — 첫 assistant 답변에 붙여 표시한다 */
  pendingSources: SourceNote[] | null;

  /** CLI 상태 조회 + 이벤트 구독 + 워크스페이스 세션 로드 */
  init(root: string): Promise<void>;
  refreshStatus(): Promise<void>;
  setAskNotes(on: boolean): void;
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
  askNotes: false,
  pendingSources: null,

  async init(root) {
    if (!subscribed) {
      subscribed = true;
      void ipc.onAgentEvent((p) => get().applyEvent(p.runId, p.event));
    }
    // 워크스페이스가 바뀌면 이전 대화는 비운다
    if (get().root !== root) {
      set({
        root,
        items: [],
        runId: null,
        running: false,
        pendingSources: null,
        sessionId: loadSessionId(root),
      });
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

  setAskNotes(on) {
    set({ askNotes: on });
  },

  async send(root, prompt) {
    if (get().running) return;
    const runId = newRunId();
    const sessionId = get().sessionId;
    const ws = useWorkspace.getState();

    // 사용자 메시지를 먼저 보여주고 running으로 전환한다.
    set((s) => ({
      root,
      runId,
      running: true,
      pendingSources: null,
      items: [...s.items, { id: nextItemId++, role: "user", text: prompt }],
    }));

    let augmented: string;
    let sources: SourceNote[] | null = null;
    try {
      if (get().askNotes) {
        // "내 노트에게 묻기": 질문으로 관련 노트를 retrieval해 근거로 첨부한다.
        // 실패하면(검색 오류 등) 컨텍스트 없이 일반 질문으로 폴백한다.
        const result = await ipc.retrieveNotes(root, prompt);
        augmented = buildAskNotesPrompt(prompt, root, result);
        sources = sourceNotesFrom(root, result);
      } else {
        // 일반 모드: 현재 열린 노트 경로만 컨텍스트로 덧붙인다 (읽기 전용).
        augmented = buildAgentPrompt(prompt, {
          root: ws.root,
          activePath: ws.activePath,
          openPaths: ws.tabs.map((t) => t.path),
        });
      }
    } catch {
      // retrieval 실패 시 원본 질문 그대로 보낸다.
      augmented = prompt;
    }

    // 다른 요청이 끼어들었으면(중단 후 새 send 등) 이 결과는 버린다.
    if (get().runId !== runId) return;
    set({ pendingSources: sources && sources.length > 0 ? sources : null });

    try {
      await ipc.agentSend(root, augmented, sessionId, runId);
    } catch (e) {
      set((s) => ({
        running: false,
        pendingSources: null,
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
    set({ items: [], sessionId: null, runId: null, pendingSources: null });
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
      case "text": {
        // "내 노트에게 묻기" 답변이면 첫 assistant 항목에 출처 노트를 붙인다.
        const sources = get().pendingSources;
        set((s) => ({
          pendingSources: null,
          items: [
            ...s.items,
            { id: nextItemId++, role: "assistant", text: event.text, ...(sources ? { sources } : {}) },
          ],
        }));
        break;
      }
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
        push("info", translate(useSettings.getState().settings.appearance.language, "agent.aborted"));
        break;
    }
  },
}));
