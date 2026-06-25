import type {
  ConfigSyncStatus,
  ConflictPreview,
  FileCommit,
  FileNode,
  RetrievalResult,
  RetrievedSnippet,
  SearchHit,
  Settings,
  SyncStatus,
  SynapseIpc,
  WorkspaceSession,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { computeBacklinks, computeGraph } from "../features/editor/backlinks";
import { basename, fileTypeOf } from "../shared/pathUtils";
import { SAMPLE_DRAWIO_XML } from "../features/drawio/fixtures";
import { SAMPLE_EXCALIDRAW_JSON } from "../features/excalidraw/fixtures";

// 브라우저(tauri 밖) 개발용 인메모리 워크스페이스.
// 파일 맵에서 트리를 파생시키므로 쓰기/생성도 실제처럼 동작한다.
const MOCK_ROOT = "/mock/notes";

const files = new Map<string, string>([
  [`${MOCK_ROOT}/README.md`, "# Mock 워크스페이스\n\n브라우저 개발 모드입니다. 실제 파일시스템은 Tauri 앱에서만 접근합니다."],
  [`${MOCK_ROOT}/daily/2026-06-10.md`, "---\ntitle: 데일리 노트\n---\n\n# 오늘 할 일\n\n- [ ] Synapse M1 마무리\n- [x] M0 완료"],
  [`${MOCK_ROOT}/ai/summary.html`, "<h1>AI 요약</h1><p>HTML 뷰어 데모 문서입니다.</p>"],
  [`${MOCK_ROOT}/assets/diagram.png`, ""],
  [`${MOCK_ROOT}/diagrams/flow.drawio`, SAMPLE_DRAWIO_XML],
  [`${MOCK_ROOT}/drawings/sketch.excalidraw`, SAMPLE_EXCALIDRAW_JSON],
]);

const emptyDirs = new Set<string>();

function buildMockTree(): FileNode {
  const root: FileNode = {
    name: basename(MOCK_ROOT),
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
      name: basename(path),
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
      name: basename(path),
      path,
      kind: "file",
      fileType: fileTypeOf(path),
    });
  }

  for (const dirPath of emptyDirs) {
    ensureDir(dirPath);
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

const TEXT_EXTS = new Set(["md", "markdown", "mdx", "txt", "html", "htm"]);

// Rust search_workspace 시맨틱을 흉내 (대소문자 무시, 파일명+내용 매칭).
function mockSearch(query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const [path, content] of [...files.entries()].sort()) {
    const name = basename(path);
    const nameMatch = name.toLowerCase().includes(needle);
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const matches: { line: number; snippet: string }[] = [];
    if (TEXT_EXTS.has(ext)) {
      content.split("\n").forEach((line, i) => {
        if (matches.length < 20 && line.toLowerCase().includes(needle)) {
          matches.push({ line: i + 1, snippet: line.trim().slice(0, 200) });
        }
      });
    }
    if (nameMatch || matches.length > 0) {
      hits.push({ path, name, nameMatch, matches });
    }
  }
  return hits;
}

const MOCK_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "from",
  "what", "which", "how", "why", "who", "when", "where", "about", "into",
  "your", "you", "our", "can", "could", "would", "should", "does", "did",
  "has", "have", "had", "will", "shall", "not", "but", "all", "any",
]);

// Rust retrieval::extract_keywords 시맨틱을 흉내 (소문자, 짧은/불용어 제거, 중복 제거).
function mockKeywords(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of question.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if ([...lower].length < 2 || MOCK_STOPWORDS.has(lower)) continue;
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
      if (out.length >= 8) break;
    }
  }
  return out;
}

// Rust retrieval::retrieve_context의 간략판 (키워드 매칭 + 파일명 가산점).
// 백링크 보강은 mock에선 생략한다(브라우저 데모용).
function mockRetrieve(question: string): RetrievalResult {
  const keywords = mockKeywords(question);
  if (keywords.length === 0) return { keywords, snippets: [] };

  const acc = new Map<
    string,
    { name: string; kws: Set<string>; nameMatch: boolean; lines: string[] }
  >();
  for (const kw of keywords) {
    for (const hit of mockSearch(kw)) {
      let entry = acc.get(hit.path);
      if (!entry) {
        entry = { name: hit.name, kws: new Set(), nameMatch: false, lines: [] };
        acc.set(hit.path, entry);
      }
      entry.kws.add(kw);
      if (hit.nameMatch) entry.nameMatch = true;
      for (const m of hit.matches) {
        if (entry.lines.length >= 3) break;
        if (!entry.lines.includes(m.snippet)) entry.lines.push(m.snippet);
      }
    }
  }

  const snippets: RetrievedSnippet[] = [...acc.entries()].map(([path, e]) => {
    const score = e.kws.size * 10 + (e.nameMatch ? 5 : 0) + Math.min(e.lines.length, 3);
    return {
      path,
      name: e.name,
      snippet: e.lines.join("\n"),
      directMatch: e.kws.size > 0,
      score,
    };
  });
  snippets.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { keywords, snippets: snippets.slice(0, 6) };
}

let recent: string[] = [];
const MAX_RECENT = 10;
let mockDocSeq = 0;

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

/** PDF 주석 사이드카의 숨김 경로(`.synapse/draw/<상대경로>.draw.json`). Rust 정책 미러. */
function pdfDrawSidecar(root: string, pdfPath: string): string {
  const rel = pdfPath.slice(root.length + 1); // "docs/report.pdf"
  return `${root}/.synapse/draw/${rel}.draw.json`;
}

/** 파일 경로로부터 결정적인(매번 동일한) 그럴듯한 더미 커밋 히스토리를 만든다 */
function mockFileHistory(path: string): FileCommit[] {
  // 경로 해시로 항목 수(2~4개)를 정해 파일마다 조금씩 다르게 보이게 한다
  let seed = 0;
  for (const ch of path) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const count = 2 + (seed % 3);
  const authors = ["기은빈", "동료 A", "Synapse"];
  const messages = [
    "오타 수정",
    "내용 추가 및 정리",
    "초안 작성",
    "구조 개편",
  ];
  const out: FileCommit[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(2026, 5, 11 - i, 10, 30 - i * 7, 0);
    const hex = ((seed + i * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");
    const hash = hex.repeat(5).slice(0, 40); // 40자 가짜 SHA-1
    out.push({
      hash,
      shortHash: hex.slice(0, 7),
      author: authors[(seed + i) % authors.length],
      timestamp: ts.toISOString(),
      message: messages[(seed + i) % messages.length],
    });
  }
  return out; // 최신순(i=0이 가장 최신)
}

export const mockIpc: SynapseIpc = {
  async pickFolder() {
    return MOCK_ROOT;
  },
  async pickFile() {
    return null;
  },
  async connectRemote() {
    throw new Error("원격 연결은 데스크톱 앱에서만 가능합니다");
  },
  async disconnectRemote() {
    // 브라우저 mock에서는 원격 세션이 없으므로 no-op
  },
  async listWorkspace(path) {
    if (path !== MOCK_ROOT) throw new Error(`not a directory: ${path}`);
    return buildMockTree();
  },
  async searchWorkspace(_root, query) {
    return mockSearch(query);
  },
  async retrieveNotes(_root, question) {
    return mockRetrieve(question);
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
  async readPdfDraw(root, pdfPath) {
    assertInside(root, pdfPath);
    const sidecar = pdfDrawSidecar(root, pdfPath);
    const fromNew = files.get(sidecar);
    if (fromNew !== undefined) return fromNew;
    const legacy = `${pdfPath}.draw.json`;
    const fromLegacy = files.get(legacy);
    if (fromLegacy !== undefined) return fromLegacy;
    throw new Error(`no such file: ${sidecar}`);
  },
  async writePdfDraw(root, pdfPath, content) {
    assertInside(root, pdfPath);
    files.set(pdfDrawSidecar(root, pdfPath), content);
    files.delete(`${pdfPath}.draw.json`); // 점진 이전: 레거시 사이드카 제거
    sync.dirty = true;
  },
  async saveDoc(root, path, content, _base) {
    void _base;
    assertInside(root, path);
    // Rust save_doc을 흉내: synapse_id가 없으면 frontmatter에 주입한다
    let final = content;
    if (!/^---\r?\n[\s\S]*?synapse_id:/m.test(content)) {
      mockDocSeq += 1;
      const id = `mock-doc-${String(mockDocSeq).padStart(8, "0")}`;
      const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
      final = fm
        ? content.replace(/^---\r?\n/, `---\nsynapse_id: ${id}\n`)
        : `---\nsynapse_id: ${id}\n---\n\n${content}`;
    }
    files.set(path, final);
    sync.dirty = true;
    return final;
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
  async createFolder(root, dir) {
    assertInside(root, `${dir === root ? root : dir}/x`);
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? "새 폴더" : `새 폴더 ${i}`;
      const path = `${dir}/${name}`;
      const taken =
        [...files.keys()].some((k) => k.startsWith(`${path}/`)) ||
        emptyDirs.has(path);
      if (!taken) {
        emptyDirs.add(path);
        return path;
      }
    }
    throw new Error("too many untitled folders");
  },
  async backlinks(root, path) {
    void root;
    return computeBacklinks(MOCK_ROOT, path, files);
  },
  async linkGraph(root) {
    void root;
    return computeGraph(MOCK_ROOT, files);
  },
  async saveImage(root, dir, desiredName, base64) {
    assertInside(root, `${dir}/x`);
    const dotAt = desiredName.lastIndexOf(".");
    const stem = dotAt > 0 ? desiredName.slice(0, dotAt) : desiredName;
    const ext = dotAt > 0 ? desiredName.slice(dotAt) : "";
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? desiredName : `${stem} ${i}${ext}`;
      if (!files.has(`${dir}/${name}`)) {
        files.set(`${dir}/${name}`, `base64:${base64.slice(0, 32)}`);
        return name;
      }
    }
    throw new Error("too many name collisions");
  },
  async writeBinaryUnique(root, dir, desiredName, base64) {
    assertInside(root, `${dir}/x`);
    const dotAt = desiredName.lastIndexOf(".");
    const stem = dotAt > 0 ? desiredName.slice(0, dotAt) : desiredName;
    const ext = dotAt > 0 ? desiredName.slice(dotAt) : "";
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? desiredName : `${stem} ${i}${ext}`;
      if (!files.has(`${dir}/${name}`)) {
        files.set(`${dir}/${name}`, `base64:${base64.slice(0, 32)}`);
        return name;
      }
    }
    throw new Error("too many name collisions");
  },
  async newWindow() {
    // 브라우저 모드: 새 탭으로 흉내
    window.open?.(location.href, "_blank");
  },

  async renamePath(root, path, newName) {
    assertInside(root, path);
    if (
      !newName ||
      newName.includes("/") ||
      newName.includes("\\") ||
      newName === "." ||
      newName === ".."
    ) {
      throw new Error("invalid name");
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    const target = `${parent}/${newName}`;
    const isDir = ![...files.keys()].includes(path);
    if (files.has(target) || [...files.keys()].some((k) => k.startsWith(`${target}/`))) {
      throw new Error(`이미 존재합니다: ${newName}`);
    }
    if (isDir) {
      for (const [k, v] of [...files]) {
        if (k.startsWith(`${path}/`)) {
          files.delete(k);
          files.set(target + k.slice(path.length), v);
        }
      }
    } else {
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      files.delete(path);
      files.set(target, content);
    }
    return target;
  },
  async deletePath(root, path) {
    assertInside(root, path);
    files.delete(path);
    for (const k of [...files.keys()]) {
      if (k.startsWith(`${path}/`)) files.delete(k);
    }
  },
  async duplicatePath(root, path) {
    assertInside(root, path);
    const content = files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    const name = basename(path);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const dotAt = name.lastIndexOf(".");
    const stem = dotAt > 0 ? name.slice(0, dotAt) : name;
    const ext = dotAt > 0 ? name.slice(dotAt) : "";
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} ${i}${ext}`;
      if (!files.has(`${dir}/${candidate}`)) {
        files.set(`${dir}/${candidate}`, content);
        return candidate;
      }
    }
    throw new Error("too many name collisions");
  },
  async movePath(root, path, destDir) {
    assertInside(root, path);
    assertInside(root, `${destDir}/x`);
    const name = basename(path);
    const target = `${destDir}/${name}`;
    if (destDir === path || destDir.startsWith(`${path}/`)) {
      throw new Error("폴더를 자기 자신의 하위로 옮길 수 없습니다");
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent === destDir) return target; // 이미 그 폴더에 있음 — 무동작
    const isDir = !files.has(path);
    if (files.has(target) || [...files.keys()].some((k) => k.startsWith(`${target}/`))) {
      throw new Error(`이미 존재합니다: ${name}`);
    }
    if (isDir) {
      for (const [k, v] of [...files]) {
        if (k.startsWith(`${path}/`)) {
          files.delete(k);
          files.set(target + k.slice(path.length), v);
        }
      }
    } else {
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      files.delete(path);
      files.set(target, content);
    }
    return target;
  },
  async dragIconPath() {
    // 브라우저/테스트 환경에선 네이티브 드래그가 없으므로 더미 경로
    return "/mock/drag-icon.png";
  },
  async revealPath(path) {
    // 브라우저/테스트 환경에선 OS 파일 매니저가 없으므로 no-op
    void path;
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
  async bridgePushState() {
    // 브라우저/테스트 환경에는 브리지 서버가 없으므로 no-op.
  },

  // 브라우저/테스트 환경에는 PTY가 없으므로 터미널은 no-op로 흉내만 낸다.
  async ptyOpen() {
    return "mock-pty";
  },
  async ptyWrite() {},
  async ptyResize() {},
  async ptyKill() {},
  async onPtyData() {
    return () => {};
  },
  async onPtyExit() {
    return () => {};
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
      const path = `${MOCK_ROOT}/README.md`;
      // diff 뷰 데모용: 내 버전은 디스크 현재 내용, 원격 버전은 다른 편집본
      sync.conflict = {
        path: "README.md",
        mine: files.get(path) ?? null,
        theirs:
          "# Mock 워크스페이스\n\n원격에서 고친 줄입니다.\n실제 파일시스템은 Tauri 앱에서만 접근합니다.",
      };
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
  async conflictPreview() {
    return sync.conflict ? [sync.conflict] : [];
  },
  async resolveConflict() {
    sync.dirty = false;
    sync.conflict = null;
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

  async fileHistory(root, path) {
    assertInside(root, path);
    if (!files.has(path)) return [];
    return mockFileHistory(path);
  },
  async fileAtRevision(root, path, rev) {
    assertInside(root, path);
    const history = mockFileHistory(path);
    const idx = history.findIndex((c) => c.hash === rev);
    if (idx === -1) throw new Error(`해당 버전을 불러올 수 없습니다: ${rev}`);
    // 가장 최신(idx 0)은 현재 디스크 내용, 그 외는 그럴듯한 과거 버전을 합성
    const current = files.get(path) ?? "";
    if (idx === 0) return current;
    return `${current}\n\n<!-- mock: ${history[idx].shortHash} 시점의 이전 내용 -->`;
  },

  async getSettings() {
    return structuredClone(mockSettings);
  },
  async updateSettings(settings) {
    mockSettings = structuredClone(settings);
  },

  async configSyncStatus() {
    return structuredClone(mockConfigSync);
  },
  async configSyncAutolink() {
    // 목 모드에는 발견할 원격 레포가 없으니 현재 상태를 그대로 돌려준다(no-op).
    return structuredClone(mockConfigSync);
  },
  async linkConfigRepo(name) {
    const [owner, repo] = name.includes("/") ? name.split("/") : ["me", name];
    mockConfigSync = {
      linked: true,
      repoName: `${owner}/${repo}`,
      sync: { state: "synced", ahead: 0, behind: 0, conflictFiles: [] },
    };
    return structuredClone(mockConfigSync);
  },
  async unlinkConfigRepo() {
    mockConfigSync = { linked: false, repoName: null, sync: null };
    return structuredClone(mockConfigSync);
  },
  async configSyncNow() {
    return structuredClone(mockConfigSync);
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

  // 브라우저/테스트 환경에는 OS 워처가 없으므로 무동작 (수동 새로고침만)
  async startWatching() {},
  async stopWatching() {},
  async onFilesChanged() {
    return () => {};
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
let mockConfigSync: ConfigSyncStatus = {
  linked: false,
  repoName: null,
  sync: null,
};

const sync = {
  login: null as string | null,
  pollCount: 0,
  hasRemote: false,
  dirty: false,
  repoName: "",
  conflictOnNextSync: false,
  conflict: null as ConflictPreview | null,
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

