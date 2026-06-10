import { create } from "zustand";
import { ipc } from "../ipc/ipc";
import type { FileNode, FileType } from "../ipc/types";
import { useSettings } from "./settings";

export interface TabInfo {
  path: string;
  name: string;
  fileType: FileType;
}

export interface DocState {
  /** 현재(편집 중) 전체 파일 텍스트 — frontmatter 포함 */
  content: string;
  /** 마지막으로 디스크에 저장된 텍스트 */
  savedContent: string;
  loading: boolean;
  error: string | null;
}

export const isDirty = (doc: DocState | undefined): boolean =>
  !!doc && !doc.loading && doc.content !== doc.savedContent;

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const autosaveDelayMs = () =>
  useSettings.getState().settings.editor.autoSaveDelayMs || 1000;

interface WorkspaceState {
  recent: string[];
  root: string | null;
  tree: FileNode | null;
  loading: boolean;
  error: string | null;

  tabs: TabInfo[];
  activePath: string | null;
  docs: Record<string, DocState>;
  sourceMode: boolean;

  init(): Promise<void>;
  openFolder(path?: string): Promise<void>;
  refreshTree(): Promise<void>;
  closeWorkspace(): void;

  openFile(node: Pick<FileNode, "path" | "name" | "kind" | "fileType">): Promise<void>;
  setActiveTab(path: string): void;
  closeTab(path: string): Promise<void>;
  /** VS Code 스타일 일괄 닫기 (FR-1.7) — 미저장분은 닫기 전에 저장 */
  closeOtherTabs(path: string): Promise<void>;
  closeTabsToRight(path: string): Promise<void>;
  closeAllTabs(): Promise<void>;
  updateContent(path: string, content: string): void;
  saveDoc(path: string): Promise<void>;
  saveActive(): Promise<void>;
  createNote(): Promise<void>;
  toggleSourceMode(): void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  recent: [],
  root: null,
  tree: null,
  loading: false,
  error: null,

  tabs: [],
  activePath: null,
  docs: {},
  sourceMode: false,

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
      autosaveTimers.forEach(clearTimeout);
      autosaveTimers.clear();
      set({
        root: target,
        tree,
        recent,
        tabs: [],
        activePath: null,
        docs: {},
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

  closeWorkspace() {
    autosaveTimers.forEach(clearTimeout);
    autosaveTimers.clear();
    set({
      root: null,
      tree: null,
      tabs: [],
      activePath: null,
      docs: {},
      error: null,
    });
  },

  async openFile(node) {
    const { root, tabs, docs } = get();
    if (!root || node.kind !== "file") return;

    if (!tabs.some((t) => t.path === node.path)) {
      set({
        tabs: [...tabs, { path: node.path, name: node.name, fileType: node.fileType }],
      });
    }
    set({ activePath: node.path });

    if (docs[node.path]) return; // 이미 로드됨 (편집 중 상태 유지)
    set((s) => ({
      docs: {
        ...s.docs,
        [node.path]: { content: "", savedContent: "", loading: true, error: null },
      },
    }));
    try {
      const text = await ipc.readFile(root, node.path);
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: { content: text, savedContent: text, loading: false, error: null },
        },
      }));
    } catch (e) {
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: { content: "", savedContent: "", loading: false, error: String(e) },
        },
      }));
    }
  },

  setActiveTab(path) {
    set({ activePath: path });
  },

  async closeTab(path) {
    // 닫기 전 미저장 내용을 저장한다 (자동 저장 철학과 일관되게)
    const timer = autosaveTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      autosaveTimers.delete(path);
    }
    if (isDirty(get().docs[path])) {
      await get().saveDoc(path);
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path);
      const docs = { ...s.docs };
      delete docs[path];
      let activePath = s.activePath;
      if (activePath === path) {
        const idx = s.tabs.findIndex((t) => t.path === path);
        activePath = tabs[Math.min(idx, tabs.length - 1)]?.path ?? null;
      }
      return { tabs, docs, activePath };
    });
  },

  async closeOtherTabs(path) {
    for (const t of get().tabs.filter((t) => t.path !== path)) {
      await get().closeTab(t.path);
    }
  },

  async closeTabsToRight(path) {
    const tabs = get().tabs;
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    for (const t of tabs.slice(idx + 1)) {
      await get().closeTab(t.path);
    }
  },

  async closeAllTabs() {
    for (const t of [...get().tabs]) {
      await get().closeTab(t.path);
    }
  },

  updateContent(path, content) {
    const doc = get().docs[path];
    if (!doc) return;
    set((s) => ({ docs: { ...s.docs, [path]: { ...doc, content } } }));

    const prev = autosaveTimers.get(path);
    if (prev) clearTimeout(prev);
    autosaveTimers.set(
      path,
      setTimeout(() => {
        autosaveTimers.delete(path);
        void get().saveDoc(path);
      }, autosaveDelayMs()),
    );
  },

  async saveDoc(path) {
    const { root } = get();
    const doc = get().docs[path];
    if (!root || !doc || doc.loading || doc.content === doc.savedContent) return;
    const snapshot = doc.content;
    try {
      await ipc.writeFile(root, path, snapshot);
      set((s) => {
        const current = s.docs[path];
        if (!current) return s; // 저장 중 탭이 닫힘
        return {
          docs: { ...s.docs, [path]: { ...current, savedContent: snapshot, error: null } },
        };
      });
    } catch (e) {
      set((s) => {
        const current = s.docs[path];
        if (!current) return s;
        return { docs: { ...s.docs, [path]: { ...current, error: String(e) } } };
      });
    }
  },

  async saveActive() {
    const { activePath } = get();
    if (activePath) await get().saveDoc(activePath);
  },

  async createNote() {
    const { root } = get();
    if (!root) return;
    try {
      const path = await ipc.createNote(root, root);
      await get().refreshTree();
      await get().openFile({
        path,
        name: path.split("/").pop()!,
        kind: "file",
        fileType: "markdown",
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  toggleSourceMode() {
    set((s) => ({ sourceMode: !s.sourceMode }));
  },
}));
