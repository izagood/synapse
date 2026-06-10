import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { FileNode } from "../ipc/types";

interface WorkspaceState {
  recent: string[];
  root: string | null;
  tree: FileNode | null;
  selectedPath: string | null;
  fileContent: string | null;
  loading: boolean;
  error: string | null;

  init(): Promise<void>;
  openFolder(path?: string): Promise<void>;
  refreshTree(): Promise<void>;
  selectFile(node: FileNode): Promise<void>;
  closeWorkspace(): void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  recent: [],
  root: null,
  tree: null,
  selectedPath: null,
  fileContent: null,
  loading: false,
  error: null,

  async init() {
    try {
      set({ recent: await ipc.recentWorkspaces() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async openFolder(path) {
    set({ loading: true, error: null });
    try {
      const target = path ?? (await ipc.pickFolder());
      if (!target) {
        set({ loading: false });
        return; // 사용자가 다이얼로그를 취소
      }
      const tree = await ipc.listWorkspace(target);
      const recent = await ipc.recordWorkspaceOpened(target);
      set({
        root: target,
        tree,
        recent,
        selectedPath: null,
        fileContent: null,
        loading: false,
      });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  async refreshTree() {
    const { root } = get();
    if (!root) return;
    try {
      set({ tree: await ipc.listWorkspace(root) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async selectFile(node) {
    const { root } = get();
    if (!root || node.kind !== "file") return;
    set({ selectedPath: node.path, fileContent: null, error: null });
    try {
      const content = await ipc.readFile(root, node.path);
      // 로딩 중 다른 파일로 이동했으면 무시
      if (get().selectedPath === node.path) set({ fileContent: content });
    } catch (e) {
      if (get().selectedPath === node.path) set({ error: String(e) });
    }
  },

  closeWorkspace() {
    set({ root: null, tree: null, selectedPath: null, fileContent: null, error: null });
  },
}));
