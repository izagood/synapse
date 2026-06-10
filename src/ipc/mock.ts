import type { FileNode, FileType, SynapseIpc } from "./types";

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
    return [...recent];
  },
};
