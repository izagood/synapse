import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { mockIpc } from "./mock";
import type { FileNode, SynapseIpc } from "./types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const tauriIpc: SynapseIpc = {
  async pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },
  listWorkspace: (path) => invoke<FileNode>("list_workspace", { path }),
  readFile: (root, path) => invoke<string>("read_file", { root, path }),
  writeFile: (root, path, content) =>
    invoke<void>("write_file", { root, path, content }),
  createNote: (root, dir) => invoke<string>("create_note", { root, dir }),
  recentWorkspaces: () => invoke<string[]>("recent_workspaces"),
  recordWorkspaceOpened: (path) =>
    invoke<string[]>("record_workspace_opened", { path }),
};

export const ipc: SynapseIpc = isTauri ? tauriIpc : mockIpc;

/** 로컬 절대 경로를 webview가 로드할 수 있는 URL로 변환 (Tauri asset protocol) */
export function resolveAssetUrl(absolutePath: string): string {
  return isTauri ? convertFileSrc(absolutePath) : absolutePath;
}
