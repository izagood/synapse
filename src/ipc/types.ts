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
}
