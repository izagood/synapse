// Rust synapse-core::tree::FileNode 의 serde(camelCase) 직렬화와 1:1 대응
export type NodeKind = "dir" | "file";
export type FileType =
  | "markdown"
  | "html"
  | "pdf"
  | "image"
  | "drawio"
  | "excalidraw"
  | "other";

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

// Rust synapse-core::retrieval::{RetrievedSnippet, RetrievalResult} 와 1:1 대응 (2-C)
export interface RetrievedSnippet {
  /** 노트 절대 경로 (출처 라벨 + 클릭 시 열기용) */
  path: string;
  /** 파일명 (표시용) */
  name: string;
  /** 대표 스니펫 (매치 줄들을 합친 것). 백링크 보강 노트는 비어 있을 수 있음 */
  snippet: string;
  /** 직접 검색에 걸렸는지 (false면 백링크로 보강된 인접 노트) */
  directMatch: boolean;
  /** 랭킹 점수 */
  score: number;
}

export interface RetrievalResult {
  /** 질문에서 뽑은 키워드 */
  keywords: string[];
  /** 점수순 상위 스니펫 */
  snippets: RetrievedSnippet[];
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

// Rust synapse-core::git::ConflictPreview 와 1:1 대응 (FR-4.5 diff 뷰)
export interface ConflictPreview {
  /** 워크스페이스 루트 기준 상대 경로 */
  path: string;
  /** 내 버전 (로컬 HEAD). 내 쪽에서 삭제됐으면 null */
  mine: string | null;
  /** 원격 버전 (업스트림). 원격에서 삭제됐으면 null */
  theirs: string | null;
}

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

/** 테마 선택지: system(OS 따름) + 프리셋 테마들 */
export type ThemeSetting = "system" | "light" | "dark" | "pink";

/**
 * 캔버스 도구(excalidraw 등) 전용 테마. 앱 테마와 독립적으로 둔다 —
 * 다이어그램/드로잉은 보통 밝은 배경에서 그리므로 기본은 light 고정이고,
 * "auto"면 앱 테마를 따른다. (drawio는 이 설정과 무관하게 항상 라이트.)
 */
export type CanvasTheme = "auto" | "light" | "dark";

/** 사용자가 직접 바꿀 수 있는 색상 토큰 (활성 테마 위에 덮어쓴다) */
export const CUSTOM_COLOR_KEYS = [
  "accent",
  "bg",
  "bgPanel",
  "bgRail",
  "fg",
  "fgDim",
  "border",
] as const;
export type CustomColorKey = (typeof CUSTOM_COLOR_KEYS)[number];
/** 키→hex 색. 비어 있으면 선택한 테마의 기본값을 그대로 쓴다. */
export type CustomColors = Partial<Record<CustomColorKey, string>>;

export interface Settings {
  appearance: {
    theme: ThemeSetting;
    language: Language;
    customColors: CustomColors;
    /** 캔버스 도구(excalidraw) 전용 테마. 앱 테마와 별개. */
    canvasTheme: CanvasTheme;
  };
  editor: {
    fontFamily: string;
    fontSize: number;
    autoSaveDelayMs: number;
    /** 에디터 하단 백링크 패널 표시 여부 (기본 숨김) */
    showBacklinks: boolean;
  };
  sync: { auto: boolean; intervalMinutes: number };
  htmlViewer: { allowScripts: boolean; allowNetwork: boolean };
  files: { confirmDelete: boolean };
  terminal: { external: string; customCommand: string };
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "system", language: "ko", customColors: {}, canvasTheme: "light" },
  editor: {
    fontFamily: "system-ui",
    fontSize: 16,
    autoSaveDelayMs: 1000,
    showBacklinks: false,
  },
  sync: { auto: true, intervalMinutes: 5 },
  htmlViewer: { allowScripts: false, allowNetwork: false },
  files: { confirmDelete: true },
  terminal: { external: "terminal", customCommand: "" },
};

export interface WorkspaceSession {
  openTabs: { path: string; name: string; fileType: FileType }[];
  activePath: string | null;
}

/** workspace:files-changed 이벤트 페이로드 (외부 파일 변경 감지) */
export interface FilesChangedPayload {
  /** 변경된 파일들의 워크스페이스 루트 기준 상대경로 */
  paths: string[];
}

/**
 * Rust synapse-core::bridge::LiveState 와 1:1 대응.
 * "지금 보고 있는" 라이브 상태(저장 전 편집 버퍼 포함)를 MCP 브리지로 올리는 페이로드.
 * 외부 에이전트(claude/codex)가 Synapse MCP 사이드카를 통해 받아간다.
 */
export interface LiveStatePayload {
  /** 워크스페이스 루트(로컬 경로 또는 ssh:// URI). 시작 화면이면 null */
  root: string | null;
  /** 현재 활성 노트 경로. 열린 노트가 없으면 null */
  activePath: string | null;
  /** 현재 활성 노트의 라이브 버퍼(저장 전 편집 포함). 텍스트 노트일 때만 채워짐 */
  activeContent: string | null;
  /** 현재 열린 모든 탭 */
  openTabs: { path: string; name: string; fileType: FileType }[];
}

/** pty:data 이벤트 페이로드 — PTY 출력 청크(임의 바이트라 base64로 감쌈) */
export interface PtyDataPayload {
  /** 터미널 id (pty_open 반환값) */
  id: string;
  /** base64로 인코딩된 PTY 출력 바이트 */
  data: string;
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

// Rust synapse-core::links::{NodeKind, GraphNode, GraphEdge, LinkGraph} 와 1:1 대응 (FR-6.2)
/** 그래프 노드 종류 — 노트 파일이거나, 본문에서 추출한 해시태그 허브 */
export type GraphNodeKind = "note" | "tag";

export interface GraphNode {
  /** 노트 절대 경로, 태그 노드는 "#<tag>" (안정적 식별자) */
  path: string;
  /** 표시용 이름 (태그 노드는 "#<tag>") */
  name: string;
  kind: GraphNodeKind;
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

// Rust remote::RemoteConnection 과 1:1 대응 (원격 SSH 워크스페이스)
export interface RemoteConnection {
  /** 절대경로로 해소된 워크스페이스 루트 URI (ssh://user@host[:port]/path) */
  root: string;
}

/**
 * connect_remote가 호스트키 문제로 실패할 때의 분류. 평범한 실패는 generic.
 * unknownHostKey: known_hosts에 없는 새 호스트 — fingerprint를 보여 승인 후
 * acceptNewHostKey=true로 재시도. mismatch: 기록과 다른 키(중간자 의심) — 거부.
 */
export type RemoteConnectError =
  | { kind: "unknownHostKey"; fingerprint: string }
  | { kind: "hostKeyMismatch"; fingerprint: string }
  | { kind: "generic"; message: string };

// Rust remote::ParsedRemoteTarget 과 1:1 대응 (ssh 명령어 → 접속 대상)
export interface ParsedRemoteTarget {
  /** ssh://user@host[:port] (경로는 비어 있음 — 연결 후 홈으로 해소) */
  uri: string;
  /** -i/IdentityFile 로 지정된 키 경로 (없으면 null) */
  keyPath: string | null;
}

// Rust remote::RemoteDirEntry 과 1:1 대응 (디렉토리 브라우저 한 항목)
export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
}

export interface SynapseIpc {
  /** OS 폴더 선택 다이얼로그. 취소 시 null */
  pickFolder(): Promise<string | null>;
  /** OS 파일 선택 다이얼로그(예: SSH 개인키 선택). 취소 시 null */
  pickFile(): Promise<string | null>;
  /**
   * 원격 SSH 호스트에 연결·인증하고 세션을 등록한다. 성공하면 절대경로로
   * 해소된 루트 URI를 돌려준다(빈 경로는 원격 홈으로 해소). 호스트키가
   * known_hosts에 없으면 acceptNewHostKey=false일 때 unknownHostKey로 거부된다.
   */
  connectRemote(
    uri: string,
    keyPath: string | null,
    password: string | null,
    passphrase: string | null,
    acceptNewHostKey: boolean,
  ): Promise<RemoteConnection>;
  /** 원격 세션을 끊는다(같은 호스트의 공유 연결 종료) */
  disconnectRemote(uri: string): Promise<void>;
  /**
   * `ssh ...` 명령어 한 줄을 접속 대상으로 해소한다(~/.ssh/config 별칭 병합).
   * 연결은 하지 않는다 — 결과 uri/keyPath를 connectRemote에 넘긴다.
   */
  parseSshCommand(command: string): Promise<ParsedRemoteTarget>;
  /** 연결된 원격 세션에서 uri가 가리키는 디렉토리의 바로 아래 항목을 나열한다. */
  listRemoteDir(uri: string): Promise<RemoteDirEntry[]>;
  /** 폴더를 재귀 스캔해 파일 트리 반환 */
  listWorkspace(path: string): Promise<FileNode>;
  /**
   * 워크스페이스를 열 때 한 번씩 부르는 마이그레이션: 레거시 CRDT 데이터
   * 디렉토리(`.synapse`) 잔재를 정리한다(PDF 드로잉 사이드카가 있는
   * `.synapse/draw/`는 보존). 실패해도 워크스페이스 열기를 막아선 안 되므로
   * 호출측은 fire-and-forget으로 부르고 실패를 무시한다.
   */
  migrateWorkspace(root: string): Promise<boolean>;
  /** 워크스페이스 전체 텍스트 검색(파일명+내용). 빈 질의는 빈 결과 (FR-1.5) */
  searchWorkspace(root: string, query: string): Promise<SearchHit[]>;
  /**
   * "내 노트에게 묻기"용 retrieval (2-C): 질문에서 키워드를 뽑아 워크스페이스를
   * 검색하고 백링크로 인접 노트를 보강해 근거 스니펫(출처 포함)을 모은다.
   * 임베딩이 아닌 키워드 매칭 기반 v1.
   */
  retrieveNotes(root: string, question: string): Promise<RetrievalResult>;
  /** 워크스페이스 루트 내부 파일만 읽기 허용 */
  readFile(root: string, path: string): Promise<string>;
  /** 루트 내부 경로에만 원자적 쓰기 허용 (새 파일 생성 포함) */
  writeFile(root: string, path: string, content: string): Promise<void>;
  /**
   * PDF 주석(드로잉) 사이드카 읽기. 숨김 디렉토리 `.synapse/draw/<상대경로>.draw.json`을
   * 우선 읽고, 없으면 기존 PDF옆 `<pdf>.draw.json`을 폴백으로 읽는다(점진 이전).
   * 둘 다 없으면 reject — 호출측은 "주석 없음"으로 처리한다.
   */
  readPdfDraw(root: string, pdfPath: string): Promise<string>;
  /**
   * PDF 주석(드로잉) 사이드카 쓰기. 항상 `.synapse/draw` 안에 저장하고, 저장 성공 후
   * 기존 PDF옆 `<pdf>.draw.json`이 남아 있으면 삭제해 새 위치로 이전한다.
   */
  writePdfDraw(root: string, pdfPath: string, content: string): Promise<void>;
  /**
   * 마크다운 문서 저장. 저장 직전 디스크가 `base`(에디터가 마지막에 본 기준)
   * 에서 갈라져 있으면(외부 도구·브리지 편집·sync 병합이 그 사이에 파일을
   * 바꿨다는 뜻) 무조건 덮어써 미커밋 바이트를 파괴하지 않고, `base`·디스크·
   * `content`를 stateless 3-way로 병합해 양쪽을 보존한다. 레거시 frontmatter
   * `synapse_id`가 남아 있으면 지연 제거하고, 최종 저장 텍스트를 돌려준다
   * (병합·strip으로 바뀌었을 수 있어 에디터가 이 반환값을 반영해야 한다).
   */
  saveDoc(root: string, path: string, content: string, base: string): Promise<string>;
  /** dir 안에 "새 노트.md" 계열의 겹치지 않는 빈 노트 생성, 생성된 경로 반환 */
  createNote(root: string, dir: string): Promise<string>;
  /** dir 안에 "새 폴더" 계열의 겹치지 않는 빈 폴더 생성, 생성된 폴더 URI 반환 */
  createFolder(root: string, dir: string): Promise<string>;
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
  /**
   * 바이너리(base64) 바이트를 dir에 새 파일로 쓴다. 같은 이름이 있으면 "이름 2.ext"로
   * 비켜 쓰고 최종 파일명을 반환 (PDF 굽기 등 임의 바이너리 저장용)
   */
  writeBinaryUnique(root: string, dir: string, desiredName: string, base64: string): Promise<string>;
  /** 새 앱 창 열기 (여러 폴더 동시 사용) */
  newWindow(): Promise<void>;

  // ---- 파일 작업 (FR-1.3) ----
  /** 같은 폴더 안에서 이름 변경 (덮어쓰기 거부), 새 절대 경로 반환 */
  renamePath(root: string, path: string, newName: string): Promise<string>;
  /** 파일/폴더 삭제 (복구 불가 — UI에서 확인 필수) */
  deletePath(root: string, path: string): Promise<void>;
  /** 파일을 "이름 2.ext"로 복제, 새 파일명 반환 */
  duplicatePath(root: string, path: string): Promise<string>;
  /**
   * 파일/폴더를 워크스페이스 내부의 다른 폴더로 이동(트리 드래그앤드롭).
   * 대상에 같은 이름이 있으면 실패. 옮긴 새 절대 경로(원격이면 URI) 반환.
   */
  movePath(root: string, path: string, destDir: string): Promise<string>;
  /**
   * 트리 항목을 OS로 끌어 내보낼 때 쓰는 드래그 미리보기 아이콘의 절대 경로.
   * (tauri-plugin-drag의 startDrag는 icon 인자가 필수다)
   */
  dragIconPath(): Promise<string>;
  /** OS 파일 매니저(Finder/탐색기)에서 해당 항목을 선택해 보여준다 */
  revealPath(path: string): Promise<void>;
  /** 최근 연 폴더 (최신순) */
  recentWorkspaces(): Promise<string[]>;
  /** 폴더 열람 기록, 갱신된 최근 목록 반환 */
  recordWorkspaceOpened(path: string): Promise<string[]>;
  /** 최근 연 폴더 목록을 전부 비운다 (시작 화면 "모두 지우기") */
  clearRecentWorkspaces(): Promise<void>;
  /** 앱 재시작 시 복원할 워크스페이스 (명시적으로 닫았거나 폴더가 없으면 null) */
  getLastWorkspace(): Promise<string | null>;
  clearLastWorkspace(): Promise<void>;
  /** 워크스페이스별 세션(열린 탭 등) — FR-5.5: 폴더가 아닌 전역 레지스트리에 저장 */
  getWorkspaceState(root: string): Promise<WorkspaceSession | null>;
  setWorkspaceState(root: string, state: WorkspaceSession): Promise<void>;

  // ---- 라이브 상태 브리지 (MCP) ----
  /**
   * 현재 윈도우의 라이브 상태(활성 노트·저장 전 버퍼·열린 탭)를 앱 내부 브리지
   * 서버에 올린다. 외부 에이전트가 띄운 Synapse MCP 사이드카가 이를 질의한다.
   * 윈도우 라벨은 IPC 계층에서 채워 넣는다(호출자는 라이브 상태만 넘긴다).
   */
  bridgePushState(live: LiveStatePayload): Promise<void>;
  /**
   * 워크스페이스 루트를 열 때 브리지 발견 정보를 발행한다. 이 윈도우의 브리지
   * 접속 정보(포트·토큰)를 ~/.config/synapse/bridge.json에 쓰고, 외부 터미널이
   * 이 파일을 읽어 접속할 수 있도록 한다. 윈도우 라벨은 IPC 계층에서 채워 넣는다.
   */
  bridgePublishDiscovery(root: string): Promise<void>;

  /**
   * 선택된 OS 터미널을 연다(터미널 선택은 settings.terminal). cwd를 주면 거기서,
   * 없으면 워크스페이스 root에서 연다. spawn 실패는 reject로 표면화한다.
   */
  openExternalTerminal(root: string, cwd?: string): Promise<void>;

  // ---- 내장 터미널 (PTY) ----
  /**
   * 새 PTY를 연다. 셸은 플랫폼 기본값, cwd는 워크스페이스 루트(ssh://면 홈),
   * 자식 env에 브리지 접속 정보가 주입된다. 이후 write/resize/kill에 쓸 id를 반환.
   */
  ptyOpen(root: string | null, cols: number, rows: number): Promise<string>;
  /** 사용자 입력(키 입력 등)을 PTY에 쓴다 */
  ptyWrite(id: string, data: string): Promise<void>;
  /** 터미널 크기 변경 */
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  /** 터미널 종료 + 세션 정리 */
  ptyKill(id: string): Promise<void>;
  /** PTY 출력(base64) 구독. 해제 함수 반환 */
  onPtyData(handler: (payload: PtyDataPayload) => void): Promise<() => void>;
  /** PTY 종료(id) 구독. 해제 함수 반환 */
  onPtyExit(handler: (id: string) => void): Promise<() => void>;

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
  /** 충돌한 파일들의 내 버전·원격 버전 내용 (FR-4.5 diff 뷰). 충돌이 없으면 빈 배열 */
  conflictPreview(root: string): Promise<ConflictPreview[]>;
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
  /**
   * 새 기기 자동 연결: GitHub 로그인 직후 호출한다. 미연결 상태에서 로그인 계정에
   * `{login}/synapse-config` 레포가 있으면 자동으로 clone·연결한다. 없거나 이미
   * 연결돼 있으면 현재 상태를 그대로 돌려준다(no-op).
   */
  configSyncAutolink(): Promise<ConfigSyncStatus>;
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

  // ---- 외부 파일 변경 감시 (수동 새로고침 없이 자동 reload) ----
  /**
   * 워크스페이스 루트를 OS 워처로 재귀 감시 시작(기존 감시는 교체).
   * 로컬 폴더만 감시하며, 원격(ssh://)이면 무동작이다.
   */
  startWatching(root: string): Promise<void>;
  /** 감시 중단 (idempotent) */
  stopWatching(): Promise<void>;
  /** 외부 파일 변경 이벤트 구독. 해제 함수를 반환한다 */
  onFilesChanged(handler: (payload: FilesChangedPayload) => void): Promise<() => void>;

  // ---- 앱 업데이트 (F2) ----
  appVersion(): Promise<string>;
  /** 새 버전이 있으면 버전 정보, 없으면 null */
  checkUpdate(): Promise<{ version: string } | null>;
  /** 다운로드·설치 후 앱 재시작 (성공 시 resolve 전에 재시작됨) */
  installUpdate(): Promise<void>;
}
