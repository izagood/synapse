import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { mockIpc } from "./mock";
import type {
  AgentEventPayload,
  AgentStatus,
  ConfigSyncStatus,
  Backlink,
  LinkGraph,
  DeviceCode,
  FileCommit,
  FileNode,
  PollResult,
  RetrievalResult,
  SearchHit,
  Settings,
  SyncStatus,
  SynapseIpc,
  WorkspaceSession,
} from "./types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const tauriIpc: SynapseIpc = {
  async pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },
  listWorkspace: (path) => invoke<FileNode>("list_workspace", { path }),
  searchWorkspace: (root, query) =>
    invoke<SearchHit[]>("search_workspace", { root, query }),
  retrieveNotes: (root, question) =>
    invoke<RetrievalResult>("retrieve_notes", { root, question }),
  readFile: (root, path) => invoke<string>("read_file", { root, path }),
  writeFile: (root, path, content) =>
    invoke<void>("write_file", { root, path, content }),
  saveDoc: (root, path, content, base) =>
    invoke<string>("save_doc", { root, path, content, base }),
  createNote: (root, dir) => invoke<string>("create_note", { root, dir }),
  backlinks: (root, path) => invoke<Backlink[]>("backlinks", { root, path }),
  linkGraph: (root) => invoke<LinkGraph>("link_graph", { root }),
  saveImage: (root, dir, desiredName, base64) =>
    invoke<string>("save_image", { root, dir, desiredName, dataBase64: base64 }),
  newWindow: () => invoke<void>("new_window"),
  renamePath: (root, path, newName) =>
    invoke<string>("rename_path", { root, path, newName }),
  deletePath: (root, path) => invoke<void>("delete_path", { root, path }),
  duplicatePath: (root, path) => invoke<string>("duplicate_path", { root, path }),
  recentWorkspaces: () => invoke<string[]>("recent_workspaces"),
  recordWorkspaceOpened: (path) =>
    invoke<string[]>("record_workspace_opened", { path }),
  getLastWorkspace: () => invoke<string | null>("get_last_workspace"),
  clearLastWorkspace: () => invoke<void>("clear_last_workspace"),
  async getWorkspaceState(root) {
    const state = await invoke<WorkspaceSession | null>("get_workspace_state", {
      path: root,
    });
    return state && Array.isArray(state.openTabs) ? state : null;
  },
  setWorkspaceState: (root, state) =>
    invoke<void>("set_workspace_state", { path: root, state }),

  githubLoginStart: () => invoke<DeviceCode>("github_login_start"),
  githubLoginPoll: () => invoke<PollResult>("github_login_poll"),
  githubUser: () => invoke<string | null>("github_user"),
  githubLogout: () => invoke<void>("github_logout"),
  openExternal: (url) => openUrl(url),

  syncStatus: (root) => invoke<SyncStatus>("sync_status", { root }),
  syncNow: (root, message) => invoke<SyncStatus>("sync_now", { root, message }),
  resolveConflict: (root, choice) =>
    invoke<SyncStatus>("resolve_conflict", { root, choice }),
  publishWorkspace: (root, name, isPrivate) =>
    invoke<SyncStatus>("publish_workspace", { root, name, private: isPrivate }),
  cloneRepo: (url, parentDir, name) =>
    invoke<string>("clone_repo", { url, parentDir, name }),

  fileHistory: (root, path) =>
    invoke<FileCommit[]>("file_history", { root, path }),
  fileAtRevision: (root, path, rev) =>
    invoke<string>("file_at_revision", { root, path, rev }),

  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings) => invoke<void>("update_settings", { settings }),

  configSyncStatus: () => invoke<ConfigSyncStatus>("config_sync_status"),
  linkConfigRepo: (name, create) =>
    invoke<ConfigSyncStatus>("link_config_repo", { name, create }),
  unlinkConfigRepo: (keepLocal) =>
    invoke<ConfigSyncStatus>("unlink_config_repo", { keepLocal }),
  configSyncNow: () => invoke<ConfigSyncStatus>("config_sync_now"),

  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),

  async prepareHtmlView(cacheName, html) {
    const path = await invoke<string>("viewer_cache_write", {
      fileName: cacheName,
      content: html,
    });
    return convertFileSrc(path);
  },

  agentStatus: () => invoke<AgentStatus>("agent_status"),
  agentSend: (root, prompt, sessionId, runId) =>
    invoke<void>("agent_send", { root, prompt, sessionId, runId }),
  agentRespondPermission: (requestId, allow) =>
    invoke<void>("agent_respond_permission", { requestId, allow }),
  agentEditFile: (root, path, newContent, baseContent) =>
    invoke<string>("agent_edit_file", { root, path, newContent, baseContent }),
  agentStop: () => invoke<void>("agent_stop"),
  onAgentEvent: (handler) =>
    listen<AgentEventPayload>("agent:event", (e) => handler(e.payload)),

  setAgentApiKey: (key) => invoke<void>("set_agent_api_key", { key }),
  clearAgentApiKey: () => invoke<void>("clear_agent_api_key"),
  hasAgentApiKey: () => invoke<boolean>("has_agent_api_key"),

  appVersion: () => getVersion(),
  async checkUpdate() {
    const update = await check();
    pendingUpdate = update;
    return update ? { version: update.version } : null;
  },
  async installUpdate() {
    if (!pendingUpdate) throw new Error("설치할 업데이트가 없습니다");
    await pendingUpdate.downloadAndInstall();
    await relaunch();
  },
};

let pendingUpdate: Update | null = null;

export const ipc: SynapseIpc = isTauri ? tauriIpc : mockIpc;

/** 로컬 절대 경로를 webview가 로드할 수 있는 URL로 변환 (Tauri asset protocol) */
export function resolveAssetUrl(absolutePath: string): string {
  return isTauri ? convertFileSrc(absolutePath) : absolutePath;
}
