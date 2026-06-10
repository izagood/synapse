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
export interface Settings {
  appearance: { theme: "system" | "light" | "dark"; language: string };
  editor: {
    fontFamily: string;
    fontSize: number;
    autoSaveDelayMs: number;
    assetsFolder: string;
  };
  sync: { auto: boolean; intervalMinutes: number };
  htmlViewer: { allowScripts: boolean; allowNetwork: boolean };
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
};

export interface SynapseIpc {
  /** OS 폴더 선택 다이얼로그. 취소 시 null */
  pickFolder(): Promise<string | null>;
  /** 폴더를 재귀 스캔해 파일 트리 반환 */
  listWorkspace(path: string): Promise<FileNode>;
  /** 워크스페이스 루트 내부 파일만 읽기 허용 */
  readFile(root: string, path: string): Promise<string>;
  /** 루트 내부 경로에만 원자적 쓰기 허용 (새 파일 생성 포함) */
  writeFile(root: string, path: string, content: string): Promise<void>;
  /** dir 안에 "새 노트.md" 계열의 겹치지 않는 빈 노트 생성, 생성된 경로 반환 */
  createNote(root: string, dir: string): Promise<string>;
  /** 최근 연 폴더 (최신순) */
  recentWorkspaces(): Promise<string[]>;
  /** 폴더 열람 기록, 갱신된 최근 목록 반환 */
  recordWorkspaceOpened(path: string): Promise<string[]>;

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

  // ---- 전역 설정 (FR-5) ----
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;

  // ---- 앱 업데이트 (F2) ----
  appVersion(): Promise<string>;
  /** 새 버전이 있으면 버전 정보, 없으면 null */
  checkUpdate(): Promise<{ version: string } | null>;
  /** 다운로드·설치 후 앱 재시작 (성공 시 resolve 전에 재시작됨) */
  installUpdate(): Promise<void>;
}
