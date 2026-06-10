import type { FileNode, SynapseIpc } from "./types";

// 브라우저(tauri 밖) 개발용 인메모리 워크스페이스
const MOCK_ROOT = "/mock/notes";

const mockFiles: Record<string, string> = {
  [`${MOCK_ROOT}/README.md`]: "# Mock 워크스페이스\n\n브라우저 개발 모드입니다. 실제 파일시스템은 Tauri 앱에서만 접근합니다.",
  [`${MOCK_ROOT}/daily/2026-06-10.md`]: "# 오늘 할 일\n\n- [ ] Synapse M0 마무리",
  [`${MOCK_ROOT}/ai/summary.html`]: "<h1>AI 요약</h1><p>HTML 뷰어는 M2에서 렌더링됩니다.</p>",
};

const mockTree: FileNode = {
  name: "notes",
  path: MOCK_ROOT,
  kind: "dir",
  fileType: "other",
  children: [
    {
      name: "ai",
      path: `${MOCK_ROOT}/ai`,
      kind: "dir",
      fileType: "other",
      children: [
        { name: "summary.html", path: `${MOCK_ROOT}/ai/summary.html`, kind: "file", fileType: "html" },
      ],
    },
    {
      name: "daily",
      path: `${MOCK_ROOT}/daily`,
      kind: "dir",
      fileType: "other",
      children: [
        { name: "2026-06-10.md", path: `${MOCK_ROOT}/daily/2026-06-10.md`, kind: "file", fileType: "markdown" },
      ],
    },
    { name: "README.md", path: `${MOCK_ROOT}/README.md`, kind: "file", fileType: "markdown" },
  ],
};

let recent: string[] = [];
const MAX_RECENT = 10;

export const mockIpc: SynapseIpc = {
  async pickFolder() {
    return MOCK_ROOT;
  },
  async listWorkspace(path) {
    if (path !== MOCK_ROOT) throw new Error(`not a directory: ${path}`);
    return mockTree;
  },
  async readFile(root, path) {
    if (!path.startsWith(root)) throw new Error(`path escapes workspace root: ${path}`);
    const content = mockFiles[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  },
  async recentWorkspaces() {
    return [...recent];
  },
  async recordWorkspaceOpened(path) {
    recent = [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
    return [...recent];
  },
};
