import { create } from "zustand";
import { ipc, parseRemoteConnectError } from "../ipc/ipc";
import type { FileNode, FileType, RemoteConnectError } from "../ipc/types";
import { ancestorDirsOf } from "../features/workspace/fileTreeUtils";
import { basename, fileTypeOf } from "../shared/pathUtils";
import { useSettings } from "./settings";
import { htmlToMarkdown } from "../features/html/htmlToMarkdown";
import {
  htmlExportPath,
  markdownToStandaloneHtml,
  titleFromPath,
} from "../features/html/markdownToHtml";

export interface TabInfo {
  path: string;
  name: string;
  fileType: FileType;
}

export interface DocState {
  /** 현재(편집 중) 전체 파일 텍스트 — frontmatter 포함 */
  content: string;
  /**
   * 에디터가 마지막으로 본 디스크 텍스트 — CRDT 저장의 diff 기준(base).
   * content는 항상 여기서 출발한 편집이어야 위치 변환 머지가 정확하다.
   */
  savedContent: string;
  /**
   * 에디터 밖에서 content가 통째로 바뀐 횟수 (원격 머지 반영 등).
   * 열려 있는 에디터는 이 값이 바뀌면 content를 다시 읽어 적용한다.
   */
  externalRev: number;
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
  /** 트리에서 펼쳐진 디렉터리 절대 경로 집합 */
  expandedDirs: Record<string, true>;

  init(): Promise<void>;
  openFolder(path?: string): Promise<void>;
  /**
   * 원격 SSH 호스트에 연결한 뒤 해소된 루트를 워크스페이스로 연다.
   * 성공하면 null, 실패하면 분류된 오류를 돌려준다(호스트키 미등록/불일치는
   * UI가 fingerprint를 보여 처리). 성공 시 openFolder와 동일한 상태가 된다.
   */
  openRemote(
    uri: string,
    opts: {
      keyPath?: string | null;
      password?: string | null;
      passphrase?: string | null;
      acceptNewHostKey?: boolean;
    },
  ): Promise<RemoteConnectError | null>;
  refreshTree(): Promise<void>;
  closeWorkspace(): void;

  openFile(node: Pick<FileNode, "path" | "name" | "kind" | "fileType">): Promise<void>;
  /**
   * 절대 경로로 트리에서 파일을 찾아 연다 (노트 내 내부 링크 이동용).
   * 확장자가 없으면 `.md`를 붙여 재시도. 트리에 없으면 false.
   */
  openFileAt(path: string): Promise<boolean>;
  setActiveTab(path: string): void;
  closeTab(path: string): Promise<void>;
  /** VS Code 스타일 일괄 닫기 (FR-1.7) — 미저장분은 닫기 전에 저장 */
  closeOtherTabs(path: string): Promise<void>;
  closeTabsToRight(path: string): Promise<void>;
  closeAllTabs(): Promise<void>;
  updateContent(path: string, content: string): void;
  saveDoc(path: string): Promise<void>;
  saveActive(): Promise<void>;
  /** 미저장 문서를 전부 저장 (동기화 직전 호출) */
  flushDirty(): Promise<void>;
  /** sync 후 열린 문서에 원격 변경을 반영 — 깨끗하면 다시 읽고, 편집 중이면 CRDT 머지 저장 */
  reloadAfterSync(): Promise<void>;
  createNote(dir?: string): Promise<void>;
  /**
   * HTML 텍스트(AI 산출물 등)를 정화·변환해 새 마크다운 노트로 가져온다 (FR-3.4).
   * 생성된 노트를 열고, 생성 경로를 반환한다.
   */
  importHtmlAsNote(html: string, dir?: string): Promise<string | null>;
  /**
   * 활성(또는 지정) 노트를 자기완결적 HTML 문서로 같은 폴더에 내보낸다 (FR-3.5).
   * 내보낸 .html 경로를 반환한다.
   */
  exportNoteAsHtml(path?: string): Promise<string | null>;
  toggleSourceMode(): void;
  /** 트리 폴더 펼침/접기 */
  toggleDir(path: string): void;
  /** 파일의 조상 폴더를 전부 펼친다 (추가 전용 — 접지 않음) */
  revealPath(path: string): void;

  // ---- 파일 작업 (FR-1.3, VS Code 스타일 우클릭) ----
  /** 저장 없이 탭을 닫는다 (삭제된 파일 정리용) */
  closeTabDiscard(path: string): void;
  renameEntry(node: Pick<FileNode, "path" | "kind">, newName: string): Promise<void>;
  deleteEntry(node: Pick<FileNode, "path" | "kind">): Promise<void>;
  duplicateEntry(node: Pick<FileNode, "path">): Promise<void>;
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
  expandedDirs: {},

  async init() {
    try {
      set({ recent: await ipc.recentWorkspaces() });
      // dock 메뉴의 최근 폴더로 열린 창이면 지정된 폴더를 바로 연다
      const flags =
        typeof window !== "undefined"
          ? (window as {
              __SYNAPSE_FRESH_WINDOW__?: boolean;
              __SYNAPSE_OPEN_FOLDER__?: string;
            })
          : {};
      if (flags.__SYNAPSE_OPEN_FOLDER__ && !get().root) {
        await get().openFolder(flags.__SYNAPSE_OPEN_FOLDER__);
        return;
      }
      // 마지막 세션 복원: 명시적으로 닫지 않았다면 이전 워크스페이스를 다시 연다.
      // 새 창(⇧⌘N)은 다른 폴더를 열기 위한 것이므로 복원 없이 시작 화면에서 출발.
      const last = await ipc.getLastWorkspace();
      if (last && !get().root && !flags.__SYNAPSE_FRESH_WINDOW__) {
        if (last.startsWith("ssh://")) {
          // 원격은 인증이 필요하다. 에이전트/키로 무인증 재연결만 시도하고
          // (비밀번호는 자동 입력하지 않는다), 실패하면 조용히 시작 화면으로
          // 폴백한다. 사용자는 시작 화면의 최근 목록에서 다시 연결할 수 있다.
          const err = await get().openRemote(last, { acceptNewHostKey: false });
          if (err) set({ loading: false, error: null });
        } else {
          await get().openFolder(last);
        }
      }
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
        expandedDirs: {},
        loading: false,
      });
      await restoreSession(target, tree, get());
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  async openRemote(uri, opts) {
    set({ loading: true, error: null });
    try {
      const conn = await ipc.connectRemote(
        uri,
        opts.keyPath ?? null,
        opts.password ?? null,
        opts.passphrase ?? null,
        opts.acceptNewHostKey ?? false,
      );
      // 연결 성공 → 해소된 루트 URI로 평소처럼 트리를 연다.
      await get().openFolder(conn.root);
      return null;
    } catch (e) {
      set({ loading: false });
      return parseRemoteConnectError(e);
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
    void ipc.clearLastWorkspace(); // 다음 시작은 시작 화면
    set({
      root: null,
      tree: null,
      tabs: [],
      activePath: null,
      docs: {},
      expandedDirs: {},
      error: null,
    });
  },

  async openFile(node) {
    const { root, tabs, docs } = get();
    if (!root || node.kind !== "file") return;

    // fileType은 항상 파일명으로 재계산한다. 세션 복원(restoreSession)은 디스크에
    // 저장된 옛 fileType을 넘기는데, 구버전에서 저장된 .png/.pdf 탭은 "other"로
    // 굳어 있어 그대로 믿으면 아래 바이너리 분기를 못 타고 readFile→UTF-8 디코드
    // 에러가 난다. 파일명 기준으로 정규화해 모든 호출 경로(트리 클릭·복원·퀵오픈·
    // 내부 링크)를 한 곳에서 교정한다.
    const fileType = fileTypeOf(node.name);

    if (!tabs.some((t) => t.path === node.path)) {
      set({
        tabs: [...tabs, { path: node.path, name: node.name, fileType }],
      });
    }
    set({ activePath: node.path });

    if (docs[node.path]) return; // 이미 로드됨 (편집 중 상태 유지)

    // PDF·이미지 등 바이너리는 텍스트로 읽지 않는다 (UTF-8 디코드 실패). 뷰어가
    // 경로를 asset URL로 직접 렌더링하므로 content 없이 곧장 준비 완료로 둔다.
    if (fileType === "pdf" || fileType === "image") {
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: { content: "", savedContent: "", externalRev: 0, loading: false, error: null },
        },
      }));
      return;
    }

    set((s) => ({
      docs: {
        ...s.docs,
        [node.path]: { content: "", savedContent: "", externalRev: 0, loading: true, error: null },
      },
    }));
    try {
      const text = await ipc.readFile(root, node.path);
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: { content: text, savedContent: text, externalRev: 0, loading: false, error: null },
        },
      }));
    } catch (e) {
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: { content: "", savedContent: "", externalRev: 0, loading: false, error: String(e) },
        },
      }));
    }
  },

  async openFileAt(path) {
    const { tree } = get();
    if (!tree) return false;
    const existing = collectFilePaths(tree);
    const target = existing.has(path)
      ? path
      : existing.has(`${path}.md`)
        ? `${path}.md`
        : null;
    if (!target) return false;
    const name = basename(target);
    await get().openFile({ path: target, name, kind: "file", fileType: fileTypeOf(name) });
    return true;
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
    const { root, tabs } = get();
    const doc = get().docs[path];
    if (!root || !doc || doc.loading || doc.content === doc.savedContent) return;
    const snapshot = doc.content;
    const isMarkdown = tabs.find((t) => t.path === path)?.fileType === "markdown";
    try {
      // 마크다운은 CRDT 경로(save_doc)로 — 원격 머지·외부 편집이 합쳐진
      // 최종 텍스트가 돌아온다. 그 외 파일은 단순 쓰기.
      const merged = isMarkdown
        ? await ipc.saveDoc(root, path, snapshot, doc.savedContent)
        : (await ipc.writeFile(root, path, snapshot), snapshot);
      set((s) => {
        const current = s.docs[path];
        if (!current) return s; // 저장 중 탭이 닫힘
        if (current.content === snapshot) {
          // 저장 중 추가 입력 없음 — 합쳐진 결과를 에디터에 그대로 반영
          return {
            docs: {
              ...s.docs,
              [path]: {
                ...current,
                content: merged,
                savedContent: merged,
                externalRev:
                  merged === snapshot ? current.externalRev : current.externalRev + 1,
                error: null,
              },
            },
          };
        }
        // 입력이 계속된 경우: base를 snapshot까지만 전진시킨다.
        // (content는 snapshot에서 출발한 편집이므로 — 다음 저장이 3-way로 합친다)
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

  async flushDirty() {
    for (const path of Object.keys(get().docs)) {
      const timer = autosaveTimers.get(path);
      if (timer) {
        clearTimeout(timer);
        autosaveTimers.delete(path);
      }
      if (isDirty(get().docs[path])) {
        await get().saveDoc(path);
      }
    }
  },

  async reloadAfterSync() {
    const { root } = get();
    if (!root) return;
    await get().refreshTree();
    for (const path of Object.keys(get().docs)) {
      const doc = get().docs[path];
      if (!doc || doc.loading) continue;
      // PDF·이미지는 바이너리라 텍스트로 다시 읽지 않는다. 뷰어가 경로를 직접
      // 렌더링하고, 파일이 바뀌면 트리 갱신만으로 충분하다.
      const binaryType = fileTypeOf(basename(path));
      if (binaryType === "pdf" || binaryType === "image") continue;
      if (isDirty(doc)) {
        // 편집 중이면 저장 경로가 곧 머지 경로다 (CRDT 3-way)
        await get().saveDoc(path);
        continue;
      }
      try {
        const text = await ipc.readFile(root, path);
        set((s) => {
          const current = s.docs[path];
          // 읽는 사이 사용자가 입력했으면 건드리지 않는다 — 다음 저장이 합친다
          if (!current || current.content !== doc.content || text === current.content) return s;
          return {
            docs: {
              ...s.docs,
              [path]: {
                ...current,
                content: text,
                savedContent: text,
                externalRev: current.externalRev + 1,
              },
            },
          };
        });
      } catch {
        // 파일이 원격에서 삭제되었을 수 있다 — 탭은 유지하고 다음 저장 시 재생성
      }
    }
  },

  async createNote(dir) {
    const { root } = get();
    if (!root) return;
    try {
      const path = await ipc.createNote(root, dir ?? root);
      await get().refreshTree();
      await get().openFile({
        path,
        name: basename(path),
        kind: "file",
        fileType: "markdown",
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async importHtmlAsNote(html, dir) {
    const { root } = get();
    if (!root) return null;
    try {
      const markdown = htmlToMarkdown(html);
      // 빈 노트를 만든 뒤 변환 결과를 채워 같은 저장 경로(saveDoc)를 탄다.
      const path = await ipc.createNote(root, dir ?? root);
      await get().refreshTree();
      await get().openFile({
        path,
        name: basename(path),
        kind: "file",
        fileType: "markdown",
      });
      get().updateContent(path, markdown ? markdown + "\n" : "");
      await get().saveDoc(path);
      return path;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  async exportNoteAsHtml(path) {
    const { root } = get();
    const target = path ?? get().activePath;
    if (!root || !target) return null;
    try {
      const content = get().docs[target]?.content ?? "";
      const html = markdownToStandaloneHtml(content, {
        title: titleFromPath(target),
      });
      const outPath = htmlExportPath(target);
      await ipc.writeFile(root, outPath, html);
      await get().refreshTree();
      return outPath;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  toggleSourceMode() {
    set((s) => ({ sourceMode: !s.sourceMode }));
  },

  toggleDir(path) {
    set((s) => {
      const expandedDirs = { ...s.expandedDirs };
      if (expandedDirs[path]) delete expandedDirs[path];
      else expandedDirs[path] = true;
      return { expandedDirs };
    });
  },

  revealPath(path) {
    const { root } = get();
    if (!root) return;
    const dirs = ancestorDirsOf(root, path);
    if (!dirs.length) return;
    set((s) => {
      if (dirs.every((d) => s.expandedDirs[d])) return s; // 변경 없음 → 리렌더 방지
      const expandedDirs = { ...s.expandedDirs };
      for (const d of dirs) expandedDirs[d] = true;
      return { expandedDirs };
    });
  },

  closeTabDiscard(path) {
    const timer = autosaveTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      autosaveTimers.delete(path);
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

  async renameEntry(node, newName) {
    const { root } = get();
    if (!root) return;
    try {
      // 영향받는 열린 탭을 먼저 저장하고 닫는다 (자동 저장이 옛 경로에 쓰지 않게)
      const affected = get().tabs.filter(
        (t) => t.path === node.path || t.path.startsWith(`${node.path}/`),
      );
      const reopen = affected.find((t) => t.path === node.path && node.kind === "file");
      for (const t of affected) {
        await get().closeTab(t.path);
      }
      const newPath = await ipc.renamePath(root, node.path, newName);
      await get().refreshTree();
      if (reopen) {
        await get().openFile({
          path: newPath,
          name: newName,
          kind: "file",
          fileType: fileTypeOf(newName),
        });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async deleteEntry(node) {
    const { root } = get();
    if (!root) return;
    try {
      for (const t of get().tabs.filter(
        (t) => t.path === node.path || t.path.startsWith(`${node.path}/`),
      )) {
        get().closeTabDiscard(t.path);
      }
      await ipc.deletePath(root, node.path);
      await get().refreshTree();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async duplicateEntry(node) {
    const { root } = get();
    if (!root) return;
    try {
      const newName = await ipc.duplicatePath(root, node.path);
      await get().refreshTree();
      const dir = node.path.slice(0, node.path.lastIndexOf("/"));
      await get().openFile({
        path: `${dir}/${newName}`,
        name: newName,
        kind: "file",
        fileType: fileTypeOf(newName),
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

function collectFilePaths(tree: FileNode, into = new Set<string>()): Set<string> {
  if (tree.kind === "file") into.add(tree.path);
  tree.children?.forEach((c) => collectFilePaths(c, into));
  return into;
}

/** 저장된 세션의 탭들을 다시 연다 — 사라진 파일은 건너뛴다 */
async function restoreSession(
  root: string,
  tree: FileNode,
  store: Pick<WorkspaceState, "openFile" | "setActiveTab">,
) {
  const session = await ipc.getWorkspaceState(root).catch(() => null);
  if (!session?.openTabs?.length) return;
  const existing = collectFilePaths(tree);
  for (const tab of session.openTabs) {
    if (existing.has(tab.path)) {
      await store.openFile({ ...tab, kind: "file" });
    }
  }
  if (session.activePath && existing.has(session.activePath)) {
    store.setActiveTab(session.activePath);
  }
}

// 활성 탭이 바뀌면 (탭 클릭·파일 열기·탭 닫기·퀵 오픈·내부 링크·세션 복원
// — 경로 불문) 트리에서 그 파일 위치를 펼친다. 단일 구독 지점이라 누락이 없다.
let lastRevealedPath: string | null = null;
useWorkspace.subscribe((s) => {
  if (s.activePath === lastRevealedPath) return;
  lastRevealedPath = s.activePath; // revealPath의 set 재진입 전에 갱신 → 루프 방지
  if (s.activePath) s.revealPath(s.activePath);
});

// 탭/활성 파일이 바뀔 때마다 세션을 전역 레지스트리에 저장 (디바운스, FR-5.5)
const SESSION_PERSIST_DELAY_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let lastPersisted = "";

useWorkspace.subscribe((s) => {
  if (!s.root) return;
  const snapshot = JSON.stringify({ root: s.root, tabs: s.tabs, activePath: s.activePath });
  if (snapshot === lastPersisted) return;
  lastPersisted = snapshot;
  const root = s.root;
  const state = { openTabs: s.tabs, activePath: s.activePath };
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void ipc.setWorkspaceState(root, state).catch(() => undefined);
  }, SESSION_PERSIST_DELAY_MS);
});
