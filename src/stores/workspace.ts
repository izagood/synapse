import { create } from "zustand";
import { ipc, parseRemoteConnectError } from "../ipc/ipc";
import type { FileNode, FileType, LiveStatePayload, RemoteConnectError } from "../ipc/types";
import { ancestorDirsOf, findNode } from "../features/workspace/fileTreeUtils";
import { isRedundantOrInvalidMove } from "../features/workspace/dndUtils";
import { basename, fileTypeOf } from "../shared/pathUtils";
import { arrayBufferToBase64 } from "../shared/binary";
import { useSettings } from "./settings";
import { htmlToMarkdown } from "../features/html/htmlToMarkdown";
import {
  htmlExportPath,
  markdownToStandaloneHtml,
  titleFromPath,
} from "../features/html/markdownToHtml";
import { emptySceneJson } from "../features/excalidraw/scene";
import { emptyDrawioXml } from "../features/drawio/drawioEmbed";

export interface TabInfo {
  path: string;
  name: string;
  fileType: FileType;
}

export interface DocState {
  /** 현재(편집 중) 전체 파일 텍스트 — frontmatter 포함 */
  content: string;
  /** 마지막으로 저장(또는 로드)된 디스크 텍스트 — content와 다르면 dirty */
  savedContent: string;
  /**
   * 에디터 밖에서 content가 통째로 바뀐 횟수 (저장 결과 반영·깨끗한 문서의
   * 외부 리로드 등). 열려 있는 에디터는 이 값이 바뀌면 content를 다시 읽어
   * 화면에 적용한다.
   */
  externalRev: number;
  /**
   * sync 중 디스크가 바뀌었는데 이 문서가 dirty라 자동으로 반영하지 못했다.
   * 탭에 배지를 띄워 사용자가 저장하면 다음 sync에서 병합됨을 알린다
   * (git이 양쪽 내용을 모두 갖고 있으므로 데이터 손실은 없다).
   */
  externalStale: boolean;
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
  /**
   * 활성 파일이 바뀔 때 에디터가 자동으로 포커스를 가져갈지.
   * 사이드바 트리에서 파일을 "선택"할 때는 false로 두어 포커스를 트리 행에
   * 유지한다(그래야 Enter로 인라인 이름 변경 진입이 동작). 새 노트 생성·퀵오픈·
   * 내부 링크 등 "바로 편집"이 자연스러운 경로에서는 true.
   */
  autoFocusEditor: boolean;
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
  /**
   * `ssh ...` 명령어를 파싱·접속만 한다(워크스페이스 루트는 바꾸지 않는다).
   * 성공하면 해소된 원격 홈 URI(`{ home }`)를 돌려줘 디렉토리 브라우저의
   * 시작점으로 쓴다. 실패는 분류된 오류(호스트키/비밀번호/일반)를 돌려준다.
   * 폴더를 고른 뒤 캐시된 세션으로 `openFolder(uri)`를 부르면 재접속 없이 열린다.
   */
  connectRemoteSession(
    command: string,
    opts: {
      password?: string | null;
      passphrase?: string | null;
      acceptNewHostKey?: boolean;
    },
  ): Promise<{ home: string } | RemoteConnectError>;
  refreshTree(): Promise<void>;
  closeWorkspace(): void;
  /** 시작 화면의 최근 폴더 목록을 전부 비운다 */
  clearRecent(): Promise<void>;

  /**
   * 파일을 탭으로 연다. `opts.focusEditor`가 false면 에디터가 자동 포커스를
   * 가져가지 않는다(사이드바에서 선택만 하고 포커스를 트리에 유지하는 경우).
   * 기본값은 true.
   */
  openFile(
    node: Pick<FileNode, "path" | "name" | "kind" | "fileType">,
    opts?: { focusEditor?: boolean },
  ): Promise<void>;
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
  /** 최근 닫은 탭 경로 스택 (최신이 마지막, 최대 10) — 재열기(⌘⇧T)용 */
  recentlyClosed: string[];
  /** 닫은 탭 다시 열기. 트리에서 사라진 파일은 건너뛰고 다음 항목을 시도한다 */
  reopenClosedTab(): Promise<void>;
  /** 활성 탭 기준 다음/이전 탭으로 순환 이동 */
  nextTab(): void;
  prevTab(): void;
  /** n번째(1-based) 탭으로. 9는 항상 마지막 탭(VS Code 관례). 범위 밖 no-op */
  goToTab(n: number): void;
  updateContent(path: string, content: string): void;
  saveDoc(path: string): Promise<void>;
  saveActive(): Promise<void>;
  /** 미저장 문서를 전부 저장 (동기화 직전 호출) */
  flushDirty(): Promise<void>;
  /**
   * sync 후 열린 문서에 원격 변경을 반영 — 깨끗하면 디스크에서 다시 읽고,
   * 편집 중(dirty)이면 라이브 머지 없이 externalStale 배지만 세운다(다음
   * 저장이 다음 sync에서 자연히 합쳐진다).
   */
  reloadAfterSync(): Promise<void>;
  createNote(dir?: string): Promise<void>;
  /** dir 안에 빈 `.excalidraw` 드로잉을 만들어 연다 */
  createDrawing(dir?: string): Promise<void>;
  /** dir 안에 빈 `.drawio` 다이어그램을 만들어 연다 */
  createDrawioFile(dir?: string): Promise<void>;
  /** dir 안에 "새 폴더" 계열의 빈 폴더를 만들고 그 경로를 반환(에디터로 열지 않음) */
  createFolder(dir?: string): Promise<string | undefined>;
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
  /** 트리 내부 드래그앤드롭: srcPath의 파일/폴더를 destDir 폴더로 옮긴다 */
  moveEntry(srcPath: string, destDir: string): Promise<void>;
  /**
   * 외부(Finder/탐색기) 파일들을 destDir 폴더로 복사해 가져온다 (드래그앤드롭).
   * 디렉터리는 호출 전에 걸러내야 한다(파일 단위로만 가져온다).
   */
  importExternalFiles(destDir: string, files: ArrayLike<File>): Promise<void>;
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
  autoFocusEditor: true,
  expandedDirs: {},
  recentlyClosed: [],

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
        recentlyClosed: [], // 다른 워크스페이스의 경로는 재열기 대상이 아니다
        loading: false,
      });
      await restoreSession(target, tree, get());
      // 레거시 `.synapse/` 정리는 fire-and-forget: 실패해도 워크스페이스
      // 열기 자체를 막지 않는다. 삭제분은 다음 sync가 자연히 커밋한다.
      void ipc.migrateWorkspace(target).catch(() => undefined);
      // 브리지 발견 항목 발행도 베스트 에포트: 실패해도 워크스페이스 열기를 막지 않는다.
      void ipc.bridgePublishDiscovery(target).catch(() => undefined);
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

  async connectRemoteSession(command, opts) {
    set({ loading: true, error: null });
    try {
      // 1) 명령어 → 접속 대상(별칭 해소). 2) 접속만 하고 루트는 그대로 둔다.
      const target = await ipc.parseSshCommand(command);
      const conn = await ipc.connectRemote(
        target.uri,
        target.keyPath,
        opts.password ?? null,
        opts.passphrase ?? null,
        opts.acceptNewHostKey ?? false,
      );
      set({ loading: false });
      return { home: conn.root };
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

  async clearRecent() {
    try {
      await ipc.clearRecentWorkspaces();
      set({ recent: [] });
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
      recentlyClosed: [],
      error: null,
    });
  },

  async openFile(node, opts) {
    const { root, tabs, docs } = get();
    if (!root || node.kind !== "file") return;

    // 에디터 자동 포커스 여부는 활성 파일을 바꾸기 전에 정해 둔다(리마운트 시
    // 에디터가 이 값을 읽음). 기본은 true, 사이드바 "선택"만 false.
    set({ autoFocusEditor: opts?.focusEditor ?? true });

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
          [node.path]: {
            content: "",
            savedContent: "",
            externalRev: 0,
            externalStale: false,
            loading: false,
            error: null,
          },
        },
      }));
      return;
    }

    set((s) => ({
      docs: {
        ...s.docs,
        [node.path]: {
          content: "",
          savedContent: "",
          externalRev: 0,
          externalStale: false,
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const text = await ipc.readFile(root, node.path);
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: {
            content: text,
            savedContent: text,
            externalRev: 0,
            externalStale: false,
            loading: false,
            error: null,
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        docs: {
          ...s.docs,
          [node.path]: {
            content: "",
            savedContent: "",
            externalRev: 0,
            externalStale: false,
            loading: false,
            error: String(e),
          },
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
    // 탭을 직접 고르는 건 "이 문서를 편집하겠다"는 의도 → 에디터에 포커스.
    set({ activePath: path, autoFocusEditor: true });
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
      // 재열기(⌘⇧T)용 스택 — 중복은 제거 후 최신으로, 최대 10개 유지.
      // closeTabDiscard(삭제된 파일 정리)는 파일이 이미 없으므로 push하지 않는다.
      const recentlyClosed = [...s.recentlyClosed.filter((p) => p !== path), path].slice(-10);
      return { tabs, docs, activePath, recentlyClosed };
    });
  },

  async reopenClosedTab() {
    const { tree } = get();
    if (!tree) return;
    const existing = collectFilePaths(tree);
    for (;;) {
      const stack = get().recentlyClosed;
      const path = stack[stack.length - 1];
      if (!path) return;
      set({ recentlyClosed: stack.slice(0, -1) });
      if (existing.has(path)) {
        const name = basename(path);
        await get().openFile({ path, name, kind: "file", fileType: fileTypeOf(name) });
        return;
      }
      // 트리에서 사라진 파일은 버리고 다음 항목 시도
    }
  },

  nextTab() {
    const { tabs, activePath } = get();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.path === activePath);
    get().setActiveTab(tabs[(idx + 1) % tabs.length].path);
  },

  prevTab() {
    const { tabs, activePath } = get();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.path === activePath);
    get().setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].path);
  },

  goToTab(n) {
    const { tabs } = get();
    if (n < 1 || n > 9) return;
    // VS Code 관례: 9는 항상 마지막 탭
    const tab = tabs[n === 9 ? tabs.length - 1 : n - 1];
    if (tab) get().setActiveTab(tab.path);
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
      // 마크다운 저장은 base(마지막으로 본 디스크 = savedContent)를 함께 넘긴다.
      // 저장 직전 디스크가 그 base에서 갈라졌으면(외부 도구·브리지·sync 병합)
      // 백엔드가 3-way로 흡수해 미커밋 바이트를 파괴하지 않는다. 돌아온 텍스트가
      // snapshot과 다를 수 있고(병합·synapse_id strip), 그 경우 에디터에도
      // 반영해야 한다(아래 applyExternal 경로). 그 외 파일은 단순 쓰기.
      const merged = isMarkdown
        ? await ipc.saveDoc(root, path, snapshot, doc.savedContent)
        : (await ipc.writeFile(root, path, snapshot), snapshot);
      set((s) => {
        const current = s.docs[path];
        if (!current) return s; // 저장 중 탭이 닫힘
        if (current.content === snapshot) {
          // 저장 중 추가 입력 없음 — strip 등으로 바뀐 결과를 에디터에 반영
          return {
            docs: {
              ...s.docs,
              [path]: {
                ...current,
                content: merged,
                savedContent: merged,
                externalRev:
                  merged === snapshot ? current.externalRev : current.externalRev + 1,
                externalStale: false,
                error: null,
              },
            },
          };
        }
        // 입력이 계속된 경우: savedContent를 snapshot까지만 전진시킨다.
        // (그 사이 들어온 추가 입력은 다음 자동 저장이 그대로 처리한다)
        // strip이 일어났다면 savedContent가 잠깐 pre-strip 텍스트(디스크와 다름)를
        // 갖지만, 다음 자동 저장이 merged를 반영하면서 수렴한다.
        return {
          docs: {
            ...s.docs,
            [path]: { ...current, savedContent: snapshot, externalStale: false, error: null },
          },
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
        // 편집 중이면 디스크에 이미 양쪽 내용이 다 있다(git이 sync 전에 커밋해
        // 둔다) — 여기서 저장하지 않는다. 디스크가 정말 발산했을 때만 배지를
        // 세우고, 발산이 없으면(디스크가 에디터 내용 또는 저장 기준과 같음)
        // 남아 있던 배지도 내린다. 다음 저장이 곧 다음 sync에서 자연히 머지된다.
        try {
          const text = await ipc.readFile(root, path);
          const diverged = text !== doc.content && text !== doc.savedContent;
          set((s) => {
            const current = s.docs[path];
            // 읽는 사이 사용자가 입력했으면 판단 기준이 낡았다 — 건드리지 않는다
            if (!current || current.content !== doc.content) return s;
            if (current.externalStale === diverged) return s;
            return { docs: { ...s.docs, [path]: { ...current, externalStale: diverged } } };
          });
        } catch {
          // 파일이 원격에서 삭제되었을 수 있다 — 외부 변경으로 간주해 배지를 세운다
          set((s) => {
            const current = s.docs[path];
            if (!current || current.externalStale) return s;
            return { docs: { ...s.docs, [path]: { ...current, externalStale: true } } };
          });
        }
        continue;
      }
      try {
        const text = await ipc.readFile(root, path);
        set((s) => {
          const current = s.docs[path];
          // 읽는 사이 사용자가 입력했으면 건드리지 않는다 — 다음 저장이 처리한다
          if (!current || current.content !== doc.content) return s;
          if (text === current.content) {
            // 디스크와 에디터가 같다 — 발산 없음. 남아 있던 배지가 있으면
            // 여기서 내린다 (undo로 깨끗해진 문서의 배지가 영영 남는 것 방지).
            if (!current.externalStale) return s;
            return { docs: { ...s.docs, [path]: { ...current, externalStale: false } } };
          }
          return {
            docs: {
              ...s.docs,
              [path]: {
                ...current,
                content: text,
                savedContent: text,
                externalRev: current.externalRev + 1,
                externalStale: false,
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

  async createFolder(dir) {
    const { root } = get();
    if (!root) return undefined;
    try {
      const path = await ipc.createFolder(root, dir ?? root);
      await get().refreshTree();
      // 부모 폴더를 펼쳐 새 폴더가 트리에 보이게 한다
      get().revealPath(path);
      return path;
    } catch (e) {
      set({ error: String(e) });
      return undefined;
    }
  },

  async createDrawing(dir) {
    const { root, tree } = get();
    if (!root || !tree) return;
    try {
      const path = uniqueFilePath(dir ?? root, collectFilePaths(tree), "드로잉", "excalidraw");
      await ipc.writeFile(root, path, emptySceneJson());
      await get().refreshTree();
      await get().openFile({
        path,
        name: basename(path),
        kind: "file",
        fileType: "excalidraw",
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async createDrawioFile(dir) {
    const { root, tree } = get();
    if (!root || !tree) return;
    try {
      const path = uniqueFilePath(dir ?? root, collectFilePaths(tree), "다이어그램", "drawio");
      await ipc.writeFile(root, path, emptyDrawioXml());
      await get().refreshTree();
      await get().openFile({
        path,
        name: basename(path),
        kind: "file",
        fileType: "drawio",
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

  async moveEntry(srcPath, destDir) {
    const { root, tree } = get();
    if (!root || !tree) return;
    if (isRedundantOrInvalidMove(srcPath, destDir)) return;
    const node = findNode(tree, srcPath);
    if (!node) return;
    try {
      // 영향받는 열린 탭을 먼저 저장·정리한다 (자동 저장이 옛 경로에 쓰지 않게).
      // 파일이면 옮긴 뒤 새 경로로 다시 연다 (renameEntry와 같은 동작).
      const affected = get().tabs.filter(
        (t) => t.path === srcPath || t.path.startsWith(`${srcPath}/`),
      );
      const reopen =
        node.kind === "file" ? affected.find((t) => t.path === srcPath) : undefined;
      for (const t of affected) {
        await get().closeTab(t.path);
      }
      const newPath = await ipc.movePath(root, srcPath, destDir);
      await get().refreshTree();
      if (reopen) {
        const name = basename(newPath);
        await get().openFile({
          path: newPath,
          name,
          kind: "file",
          fileType: fileTypeOf(name),
        });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async importExternalFiles(destDir, files) {
    const { root } = get();
    if (!root) return;
    let imported = 0;
    for (const file of Array.from(files)) {
      const name = basename(file.name);
      if (!name || name === "." || name === "..") continue;
      try {
        const base64 = arrayBufferToBase64(await file.arrayBuffer());
        await ipc.writeBinaryUnique(root, destDir, name, base64);
        imported += 1;
      } catch (e) {
        set({ error: String(e) });
      }
    }
    if (imported) await get().refreshTree();
  },
}));

function collectFilePaths(tree: FileNode, into = new Set<string>()): Set<string> {
  if (tree.kind === "file") into.add(tree.path);
  tree.children?.forEach((c) => collectFilePaths(c, into));
  return into;
}

/**
 * dir 안에서 겹치지 않는 `<baseName>.<ext>` 계열 경로를 고른다 — 이름이 이미 있으면
 * `<baseName> 2.<ext>`, `<baseName> 3.<ext>` … 로 비켜 간다 (create_unique_note의 프론트 판).
 */
function uniqueFilePath(dir: string, existing: Set<string>, baseName: string, ext: string): string {
  const base = `${dir}/${baseName}`;
  let candidate = `${base}.${ext}`;
  for (let i = 2; existing.has(candidate); i++) {
    candidate = `${base} ${i}.${ext}`;
  }
  return candidate;
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

// 활성 노트·열린 탭·저장 전 편집 버퍼가 바뀔 때마다 라이브 상태를 MCP 브리지에
// 올린다. 외부 에이전트(claude/codex)가 "지금 보고 있는 노트"를 저장 전 내용까지
// 받아갈 수 있게 한다. 동기 구간은 참조 비교만 하고(타이핑마다 전체 직렬화 방지),
// 실제 직렬화·전송은 디바운스 발화 시점에만 한다.
const BRIDGE_PUSH_DELAY_MS = 300;
let bridgeTimer: ReturnType<typeof setTimeout> | undefined;
let lastBridgeRoot: string | null = null;
let lastBridgeActive: string | null = null;
let lastBridgeTabs: TabInfo[] | null = null;
let lastBridgeDoc: DocState | undefined;
let bridgeInitialized = false;

useWorkspace.subscribe((s) => {
  const active = s.activePath;
  const doc = active ? s.docs[active] : undefined;
  // 참조만 비교 — content 변경 시 updateContent가 새 doc 객체를 만들므로 안전.
  if (
    bridgeInitialized &&
    s.root === lastBridgeRoot &&
    active === lastBridgeActive &&
    s.tabs === lastBridgeTabs &&
    doc === lastBridgeDoc
  ) {
    return;
  }
  bridgeInitialized = true;
  lastBridgeRoot = s.root;
  lastBridgeActive = active;
  lastBridgeTabs = s.tabs;
  lastBridgeDoc = doc;
  if (bridgeTimer) clearTimeout(bridgeTimer);
  bridgeTimer = setTimeout(() => {
    const cur = useWorkspace.getState();
    const a = cur.activePath;
    const d = a ? cur.docs[a] : undefined;
    const live: LiveStatePayload = {
      root: cur.root,
      activePath: a,
      // 로딩 중이 아닌 텍스트 문서일 때만 라이브 버퍼를 싣는다(PDF/이미지 등은 null).
      activeContent: d && !d.loading ? d.content : null,
      openTabs: cur.tabs,
    };
    void ipc.bridgePushState(live).catch(() => undefined);
  }, BRIDGE_PUSH_DELAY_MS);
});
