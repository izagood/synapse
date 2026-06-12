import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { AgentEvent, AgentStatus } from "../ipc/types";
import { translate } from "../i18n";
import { useSettings } from "./settings";
import { useWorkspace } from "./workspace";
import { buildAgentPrompt } from "./agentContext";
import {
  applyEditToBase,
  planApproval,
  planRejection,
  type PendingPermission,
} from "../features/agent/permission";

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
  /** 대기 중인 도구 사용 권한 요청 (있으면 승인 다이얼로그 표시) */
  pendingPermission: PendingPermission | null;
  /** AI가 이 세션에서 편집한 파일들의 절대 경로 (표시용) */
  aiEditedPaths: string[];

  /** CLI 상태 조회 + 이벤트 구독 + 워크스페이스 세션 로드 */
  init(root: string): Promise<void>;
  refreshStatus(): Promise<void>;
  send(root: string, prompt: string): Promise<void>;
  stop(): Promise<void>;
  /** 세션을 버리고 빈 대화로 시작 */
  newConversation(): void;
  applyEvent(runId: string, event: AgentEvent): void;
  /** 대기 중인 권한 요청 승인 — 편집이면 CRDT 경유로 적용한다 */
  approvePermission(): Promise<void>;
  /** 대기 중인 권한 요청 거부 */
  rejectPermission(): Promise<void>;
}

export const useAgent = create<AgentStoreState>((set, get) => ({
  status: null,
  items: [],
  running: false,
  runId: null,
  sessionId: null,
  root: null,
  pendingPermission: null,
  aiEditedPaths: [],

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
        sessionId: loadSessionId(root),
        pendingPermission: null,
        aiEditedPaths: [],
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

  async send(root, prompt) {
    if (get().running) return;
    const runId = newRunId();
    const sessionId = get().sessionId;
    // 채팅에는 사용자가 입력한 원본만 보여주고, CLI에는 현재 열린 노트
    // 컨텍스트를 앞에 덧붙인 프롬프트를 보낸다 (읽기 전용 — 경로만 알려줌).
    const ws = useWorkspace.getState();
    const augmented = buildAgentPrompt(prompt, {
      root: ws.root,
      activePath: ws.activePath,
      openPaths: ws.tabs.map((t) => t.path),
    });
    set((s) => ({
      root,
      runId,
      running: true,
      items: [...s.items, { id: nextItemId++, role: "user", text: prompt }],
    }));
    try {
      await ipc.agentSend(root, augmented, sessionId, runId);
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
    set({ items: [], sessionId: null, runId: null, pendingPermission: null, aiEditedPaths: [] });
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
      case "permissionRequest":
        // 같은 요청을 한 번만 보여준다 (중복 control_request 방어)
        if (get().pendingPermission?.requestId === event.requestId) break;
        set({
          pendingPermission: {
            requestId: event.requestId,
            tool: event.tool,
            detail: event.detail,
            edit: event.edit,
          },
        });
        break;
      case "completed": {
        const root = get().root;
        if (root) storeSessionId(root, event.sessionId);
        set({ running: false, sessionId: event.sessionId, pendingPermission: null });
        if (!event.ok) push("error", event.result);
        break;
      }
      case "failed":
        set({ running: false, pendingPermission: null });
        push("error", event.message);
        break;
      case "aborted":
        set({ running: false, pendingPermission: null });
        push("info", translate(useSettings.getState().settings.appearance.language, "agent.aborted"));
        break;
    }
  },

  async approvePermission() {
    const pending = get().pendingPermission;
    const root = get().root;
    if (!pending) return;
    set({ pendingPermission: null });
    const lang = useSettings.getState().settings.appearance.language;
    const push = (role: ChatRole, text: string) =>
      set((s) => ({ items: [...s.items, { id: nextItemId++, role, text }] }));
    const plan = planApproval(pending);
    try {
      if (plan.applyEdit && pending.edit && root) {
        // CRDT 경유 안전 편집: 현재 디스크 내용을 base로 읽어 편집을 적용한다
        const edit = pending.edit;
        let base = "";
        try {
          base = await ipc.readFile(root, edit.filePath);
        } catch {
          base = ""; // 새 파일(Write)이면 base가 없다
        }
        const next = applyEditToBase(base, edit);
        await ipc.agentEditFile(root, edit.filePath, next, base);
        set((s) => ({
          aiEditedPaths: s.aiEditedPaths.includes(edit.filePath)
            ? s.aiEditedPaths
            : [...s.aiEditedPaths, edit.filePath],
        }));
        push("info", translate(lang, "agent.editApplied", { file: edit.filePath }));
      }
      // CLI에 회신 (편집은 allowCli=false로 직접 쓰기를 막는다)
      await ipc.agentRespondPermission(pending.requestId, plan.allowCli);
    } catch (e) {
      push("error", String(e));
      // 실패해도 CLI는 거부로 회신해 멈추지 않게 한다
      try {
        await ipc.agentRespondPermission(pending.requestId, false);
      } catch {
        // 프로세스가 이미 끝났을 수 있다 — 무시
      }
    }
  },

  async rejectPermission() {
    const pending = get().pendingPermission;
    if (!pending) return;
    set({ pendingPermission: null });
    const plan = planRejection();
    try {
      await ipc.agentRespondPermission(pending.requestId, plan.allowCli);
    } catch (e) {
      set((s) => ({ items: [...s.items, { id: nextItemId++, role: "error", text: String(e) }] }));
    }
  },
}));
