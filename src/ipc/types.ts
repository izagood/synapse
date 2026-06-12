// Rust synapse-core::tree::FileNode 의 serde(camelCase) 직렬화와 1:1 대응
export type NodeKind = "dir" | "file";
export type FileType = "markdown" | "html" | "other";

export interface FileNode {
  name: string;
  path: string;
  kind: NodeKind;
  fileType: FileType;
  children?: FileNode[];
}

// Rust synapse-core::search::{SearchHit, SearchMatch} 와 1:1 대응 (FR-1.5)
export interface SearchMatch {
  line: number;
  snippet: string;
}

export interface SearchHit {
  path: string;
  name: string;
  nameMatch: boolean;
  matches: SearchMatch[];
}

// Rust synapse-core::git::SyncStatus 와 1:1 대응
export type SyncState =
  | "noGit"
  | "noRepo"
  | "noRemote"
  | "synced"
  | "pending"
  | "conflict";

export interface SyncStatus {
  state: SyncState;
  ahead: number;
  behind: number;
  conflictFiles: string[];
  message?: string;
}

export type ConflictChoice = "keepMine" | "keepRemote" | "keepBoth";

// 설정 동기화 상태 (1-E) — Rust config_sync::ConfigSyncStatus 와 1:1 대응
export interface ConfigSyncStatus {
  linked: boolean;
  repoName: string | null;
  sync: SyncStatus | null;
}
// Rust synapse-core::git::FileCommit 와 1:1 대응 (FR-4.7)
export interface FileCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601 커밋 시각 */
  timestamp: string;
  message: string;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  interval: number;
}

export type PollResult =
  | { status: "pending" }
  | { status: "slowDown" }
  | { status: "ok"; login: string }
  | { status: "failed"; message: string };

// Rust synapse-core::settings::Settings 와 1:1 대응 (FR-5)
export type Language = "ko" | "en";

/** 에이전트 인증 방식 (2-D). API 키 자체는 OS 키체인에 저장되고 여기 없다. */
export type AgentAuthMode = "subscription" | "apiKey";

export interface Settings {
  appearance: { theme: "system" | "light" | "dark"; language: Language };
  editor: {
    fontFamily: string;
    fontSize: number;
    autoSaveDelayMs: number;
    assetsFolder: string;
  };
  sync: { auto: boolean; intervalMinutes: number };
  htmlViewer: { allowScripts: boolean; allowNetwork: boolean };
  files: { confirmDelete: boolean };
  agent: { authMode: AgentAuthMode; model: string; permissionMode: string };
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "system", language: "ko" },
  editor: {
    fontFamily: "system-ui",
    fontSize: 16,
    autoSaveDelayMs: 1000,
    assetsFolder: "assets",
  },
  sync: { auto: true, intervalMinutes: 5 },
  htmlViewer: { allowScripts: false, allowNetwork: false },
  files: { confirmDelete: true },
  agent: { authMode: "subscription", model: "", permissionMode: "" },
};

// Rust synapse-core::agent::AgentEvent 와 1:1 대응 (PLAN-v0.4)
export type AgentEvent =
  | { kind: "started"; sessionId: string; model: string }
  | { kind: "text"; text: string }
  | { kind: "toolUse"; name: string; detail: string }
  | {
      kind: "completed";
      ok: boolean;
      result: string;
      sessionId: string;
      costUsd: number;
      numTurns: number;
    }
  | { kind: "failed"; message: string }
  | { kind: "aborted" };

export interface AgentEventPayload {
  runId: string;
  event: AgentEvent;
}

export interface AgentStatus {
  installed: boolean;
  path: string | null;
}

export interface WorkspaceSession {
  openTabs: { path: string; name: string; fileType: FileType }[];
  activePath: string | null;
}

// Rust synapse-core::links::Backlink 와 1:1 대응 (FR-2.8 → FR-6.1)
export interface Backlink {
  /** 링크를 가진 소스 문서의 절대 경로 */
  sourcePath: string;
  /** 소스 문서 파일명 (표시용) */
  sourceName: string;
  /** 링크가 등장한 줄(문맥) 텍스트 */
  snippet: string;
}

// Rust synapse-core::links::{GraphNode, GraphEdge, LinkGraph} 와 1:1 대응 (FR-6.2)
export interface GraphNode {
  /** 노트의 절대 경로 (안정적 식별자) */
  path: string;
  /** 표시용 파일명 */
  name: string;
}

export interface GraphEdge {
  /** 링크를 가진 소스 노트의 절대 경로 */
  source: string;
  /** 링크가 가리키는 대상 노트의 절대 경로 */
  target: string;
}

export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SynapseIpc {
  /** OS 폴더 선택 다이얼로그. 취소 시 null */
  pickFolder(): Promise<string | null>;
  /** 폴더를 재귀 스캔해 파일 트리 반환 */
  listWorkspace(path: string): Promise<FileNode>;
  /** 워크스페이스 전체 텍스트 검색(파일명+내용). 빈 질의는 빈 결과 (FR-1.5) */
  searchWorkspace(root: string, query: string): Promise<SearchHit[]>;
  /** 워크스페이스 루트 내부 파일만 읽기 허용 */
  readFile(root: string, path: string): Promise<string>;
  /** 루트 내부 경로에만 원자적 쓰기 허용 (새 파일 생성 포함) */
  writeFile(root: string, path: string, content: string): Promise<void>;
  /**
   * 마크다운 문서 저장 (FR-6 협업): base(에디터가 마지막으로 본 텍스트) 대비
   * content의 변경을 CRDT에 기록하고, 원격 머지·외부 편집까지 합쳐진 최종
   * 텍스트를 디스크에 쓴 뒤 돌려준다. frontmatter에 synapse_id가 보장된다.
   */
  saveDoc(root: string, path: string, content: string, base: string): Promise<string>;
  /** dir 안에 "새 노트.md" 계열의 겹치지 않는 빈 노트 생성, 생성된 경로 반환 */
  createNote(root: string, dir: string): Promise<string>;
  /**
   * path(현재 노트)를 가리키는 다른 노트들의 백링크를 모은다 (FR-2.8 → FR-6.1).
   * 표준 링크 `[t](rel.md)`와 위키링크 `[[basename]]`을 모두 인식한다.
   */
  backlinks(root: string, path: string): Promise<Backlink[]>;
  /**
   * 워크스페이스 전체의 노트 링크 그래프(노드=노트, 엣지=링크)를 만든다 (FR-6.2).
   * 백링크와 같은 표준/위키 링크 해석을 워크스페이스 전체에 적용한다.
   */
  linkGraph(root: string): Promise<LinkGraph>;
  /**
   * 이미지 바이트(base64)를 dir에 저장. 같은 이름이 있으면 "이름 2.ext"로
   * 비켜 쓰고 실제 저장된 파일명을 반환 (드래그앤드롭/붙여넣기)
   */
  saveImage(root: string, dir: string, desiredName: string, base64: string): Promise<string>;
  /** 새 앱 창 열기 (여러 폴더 동시 사용) */
  newWindow(): Promise<void>;

  // ---- 파일 작업 (FR-1.3) ----
  /** 같은 폴더 안에서 이름 변경 (덮어쓰기 거부), 새 절대 경로 반환 */
  renamePath(root: string, path: string, newName: string): Promise<string>;
  /** 파일/폴더 삭제 (복구 불가 — UI에서 확인 필수) */
  deletePath(root: string, path: string): Promise<void>;
  /** 파일을 "이름 2.ext"로 복제, 새 파일명 반환 */
  duplicatePath(root: string, path: string): Promise<string>;
  /** 최근 연 폴더 (최신순) */
  recentWorkspaces(): Promise<string[]>;
  /** 폴더 열람 기록, 갱신된 최근 목록 반환 */
  recordWorkspaceOpened(path: string): Promise<string[]>;
  /** 앱 재시작 시 복원할 워크스페이스 (명시적으로 닫았거나 폴더가 없으면 null) */
  getLastWorkspace(): Promise<string | null>;
  clearLastWorkspace(): Promise<void>;
  /** 워크스페이스별 세션(열린 탭 등) — FR-5.5: 폴더가 아닌 전역 레지스트리에 저장 */
  getWorkspaceState(root: string): Promise<WorkspaceSession | null>;
  setWorkspaceState(root: string, state: WorkspaceSession): Promise<void>;

  // ---- GitHub 인증 (FR-4.1) ----
  githubLoginStart(): Promise<DeviceCode>;
  githubLoginPoll(): Promise<PollResult>;
  githubUser(): Promise<string | null>;
  githubLogout(): Promise<void>;
  /** 시스템 브라우저로 URL 열기 */
  openExternal(url: string): Promise<void>;

  // ---- 동기화 (FR-4.2 ~ FR-4.5) ----
  syncStatus(root: string): Promise<SyncStatus>;
  /** message: 커밋 메시지 (시각 포함, 프론트에서 생성) */
  syncNow(root: string, message: string): Promise<SyncStatus>;
  resolveConflict(root: string, choice: ConflictChoice): Promise<SyncStatus>;
  publishWorkspace(root: string, name: string, isPrivate: boolean): Promise<SyncStatus>;
  /** parentDir/name 으로 클론하고 새 워크스페이스 경로 반환 */
  cloneRepo(url: string, parentDir: string, name: string): Promise<string>;

  // ---- 파일 히스토리 (FR-4.7) ----
  /** 한 파일의 git 커밋 히스토리(최신순). 추적 안 됨/레포 아님이면 빈 배열 */
  fileHistory(root: string, path: string): Promise<FileCommit[]>;
  /** 특정 리비전 시점의 파일 내용 (읽기 전용 미리보기·복원용) */
  fileAtRevision(root: string, path: string, rev: string): Promise<string>;

  // ---- 전역 설정 (FR-5) ----
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;

  // ---- 설정 동기화: config 레포 (1-E) ----
  /** 현재 설정 동기화 연결 상태 */
  configSyncStatus(): Promise<ConfigSyncStatus>;
  /** config 레포 연결. name="owner/repo" 또는 "repo". create=true면 새 private 레포 생성 */
  linkConfigRepo(name: string, create: boolean): Promise<ConfigSyncStatus>;
  /** 연결 해제. keepLocal이면 클라우드 설정을 로컬로 복사 보존 */
  unlinkConfigRepo(keepLocal: boolean): Promise<ConfigSyncStatus>;
  /** 설정을 지금 push/pull */
  configSyncNow(): Promise<ConfigSyncStatus>;

  /** 네이티브 창(타이틀바) 테마 동기화 — null이면 OS 테마 따름 */
  setWindowTheme(theme: "light" | "dark" | null): Promise<void>;

  /**
   * 뷰어용 HTML을 캐시에 쓰고 iframe이 로드할 수 있는 실제 URL을 돌려준다.
   * (srcdoc은 #앵커 이동·CSP 상속 문제가 있어 실제 URL로 렌더링한다, FR-3)
   */
  prepareHtmlView(cacheName: string, html: string): Promise<string>;

  // ---- Claude 에이전트 (PLAN-v0.4 Phase 1) ----
  /** claude CLI 설치 여부 (PATH + 표준 설치 경로 탐색) */
  agentStatus(): Promise<AgentStatus>;
  /**
   * 헤드리스 claude 한 턴 실행 (cwd=root, 읽기 전용 도구만 허용).
   * 응답은 onAgentEvent 스트림으로 runId와 함께 도착한다.
   * sessionId를 주면 이전 대화를 이어간다(--resume).
   */
  agentSend(root: string, prompt: string, sessionId: string | null, runId: string): Promise<void>;
  /** 실행 중인 에이전트 프로세스 중단 (aborted 이벤트로 마감됨) */
  agentStop(): Promise<void>;
  /** 에이전트 이벤트 구독. 해제 함수를 반환한다 */
  onAgentEvent(handler: (payload: AgentEventPayload) => void): Promise<() => void>;

  // ---- 에이전트 API 키 (2-D) — 키는 OS 키체인에만 저장된다 ----
  /** Anthropic API 키를 키체인에 저장(덮어쓰기). 빈 키는 거부 */
  setAgentApiKey(key: string): Promise<void>;
  /** 저장된 API 키 삭제 (idempotent) */
  clearAgentApiKey(): Promise<void>;
  /** 키체인에 API 키가 저장돼 있는지 (값은 노출하지 않음) */
  hasAgentApiKey(): Promise<boolean>;

  // ---- 앱 업데이트 (F2) ----
  appVersion(): Promise<string>;
  /** 새 버전이 있으면 버전 정보, 없으면 null */
  checkUpdate(): Promise<{ version: string } | null>;
  /** 다운로드·설치 후 앱 재시작 (성공 시 resolve 전에 재시작됨) */
  installUpdate(): Promise<void>;
}
