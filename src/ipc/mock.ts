import type {
  FileNode,
  FileType,
  Settings,
  SyncStatus,
  SynapseIpc,
  WorkspaceSession,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// 브라우저(tauri 밖) 개발용 인메모리 워크스페이스.
// 파일 맵에서 트리를 파생시키므로 쓰기/생성도 실제처럼 동작한다.
const MOCK_ROOT = "/mock/notes";

const files = new Map<string, string>([
  [`${MOCK_ROOT}/README.md`, "# Mock 워크스페이스\n\n브라우저 개발 모드입니다. 실제 파일시스템은 Tauri 앱에서만 접근합니다."],
  [`${MOCK_ROOT}/daily/2026-06-10.md`, "---\ntitle: 데일리 노트\n---\n\n# 오늘 할 일\n\n- [ ] Synapse M1 마무리\n- [x] M0 완료"],
  [`${MOCK_ROOT}/ai/summary.html`, "<h1>AI 요약</h1><p>HTML 뷰어 데모 문서입니다.</p>"],
]);

function fileTypeOf(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "other";
}

function buildMockTree(): FileNode {
  const root: FileNode = {
    name: MOCK_ROOT.split("/").pop()!,
    path: MOCK_ROOT,
    kind: "dir",
    fileType: "other",
    children: [],
  };
  const dirs = new Map<string, FileNode>([[MOCK_ROOT, root]]);

  const ensureDir = (path: string): FileNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const parent = ensureDir(path.slice(0, path.lastIndexOf("/")));
    const node: FileNode = {
      name: path.split("/").pop()!,
      path,
      kind: "dir",
      fileType: "other",
      children: [],
    };
    parent.children!.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const path of files.keys()) {
    const dir = ensureDir(path.slice(0, path.lastIndexOf("/")));
    dir.children!.push({
      name: path.split("/").pop()!,
      path,
      kind: "file",
      fileType: fileTypeOf(path),
    });
  }

  const sortChildren = (node: FileNode) => {
    node.children?.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    node.children?.forEach(sortChildren);
  };
  sortChildren(root);
  return root;
}

let recent: string[] = [];
const MAX_RECENT = 10;

const session = {
  lastWorkspace: null as string | null,
  states: new Map<string, WorkspaceSession>(),
};

/** 테스트 전용: mock 세션 상태 제어 */
export const mockSessionControl = session;

function assertInside(root: string, path: string) {
  if (!path.startsWith(`${root}/`)) {
    throw new Error(`path escapes workspace root: ${path}`);
  }
}

export const mockIpc: SynapseIpc = {
  async pickFolder() {
    return MOCK_ROOT;
  },
  async listWorkspace(path) {
    if (path !== MOCK_ROOT) throw new Error(`not a directory: ${path}`);
    return buildMockTree();
  },
  async readFile(root, path) {
    assertInside(root, path);
    const content = files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  },
  async writeFile(root, path, content) {
    assertInside(root, path);
    files.set(path, content);
    sync.dirty = true;
  },
  async createNote(root, dir) {
    assertInside(root, `${dir === root ? root : dir}/x`);
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? "새 노트.md" : `새 노트 ${i}.md`;
      const path = `${dir}/${name}`;
      if (!files.has(path)) {
        files.set(path, "");
        return path;
      }
    }
    throw new Error("too many untitled notes");
  },
  async recentWorkspaces() {
    return [...recent];
  },
  async recordWorkspaceOpened(path) {
    recent = [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
    session.lastWorkspace = path;
    return [...recent];
  },
  async getLastWorkspace() {
    return session.lastWorkspace;
  },
  async clearLastWorkspace() {
    session.lastWorkspace = null;
  },
  async getWorkspaceState(root) {
    return session.states.get(root) ?? null;
  },
  async setWorkspaceState(root, state) {
    session.states.set(root, structuredClone(state));
  },

  // ---- GitHub / 동기화 시뮬레이션 ----
  async githubLoginStart() {
    sync.pollCount = 0;
    return {
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 0.05,
    };
  },
  async githubLoginPoll() {
    sync.pollCount += 1;
    if (sync.pollCount < 2) return { status: "pending" };
    sync.login = "mock-user";
    return { status: "ok", login: sync.login };
  },
  async githubUser() {
    return sync.login;
  },
  async githubLogout() {
    sync.login = null;
  },
  async openExternal(url) {
    window.open?.(url, "_blank");
  },

  async syncStatus() {
    return currentSyncStatus();
  },
  async syncNow(_root, message) {
    sync.lastMessage = message;
    if (!sync.hasRemote) return currentSyncStatus();
    if (sync.conflictOnNextSync) {
      sync.conflictOnNextSync = false;
      return {
        state: "conflict",
        ahead: 1,
        behind: 1,
        conflictFiles: ["README.md"],
      };
    }
    sync.dirty = false;
    return currentSyncStatus();
  },
  async resolveConflict() {
    sync.dirty = false;
    return currentSyncStatus();
  },
  async publishWorkspace(_root, name) {
    if (!sync.login) throw new Error("GitHub 로그인이 필요합니다");
    sync.hasRemote = true;
    sync.dirty = false;
    sync.repoName = name;
    return currentSyncStatus();
  },
  async cloneRepo(url, parentDir, name) {
    if (!url.includes("github.com")) throw new Error(`클론 실패: ${url}`);
    sync.hasRemote = true;
    return `${parentDir}/${name}`;
  },

  async getSettings() {
    return structuredClone(mockSettings);
  },
  async updateSettings(settings) {
    mockSettings = structuredClone(settings);
  },

  async setWindowTheme() {
    // 브라우저 모드에는 네이티브 창이 없다
  },

  async prepareHtmlView(_cacheName, html) {
    if (typeof URL.createObjectURL === "function") {
      return URL.createObjectURL(new Blob([html], { type: "text/html" }));
    }
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  },

  async appVersion() {
    return "0.2.0-dev";
  },
  async checkUpdate() {
    return sync.updateAvailable ? { version: sync.updateAvailable } : null;
  },
  async installUpdate() {
    if (!sync.updateAvailable) throw new Error("설치할 업데이트가 없습니다");
    sync.updateAvailable = null;
  },
};

let mockSettings: Settings = structuredClone(DEFAULT_SETTINGS);

const sync = {
  login: null as string | null,
  pollCount: 0,
  hasRemote: false,
  dirty: false,
  repoName: "",
  conflictOnNextSync: false,
  lastMessage: "",
  updateAvailable: null as string | null,
};

function currentSyncStatus(): SyncStatus {
  if (!sync.hasRemote) return { state: "noRepo", ahead: 0, behind: 0, conflictFiles: [] };
  return {
    state: sync.dirty ? "pending" : "synced",
    ahead: sync.dirty ? 1 : 0,
    behind: 0,
    conflictFiles: [],
  };
}

/** 테스트 전용: mock 동기화 상태 제어 */
export const mockSyncControl = sync;
