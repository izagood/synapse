/** 최근 폴더 목록에서 원격(SSH) 워크스페이스인지 — SSH 배지·서버 아이콘 표시용 */
export const isRemoteWorkspace = (path: string): boolean => path.startsWith("ssh://");

/**
 * 최근 폴더 행의 보조 경로 표시용 문자열.
 * 원격 URI는 `ssh://` 스킴을 벗겨 `user@host[:port]/path`로 보여준다
 * (배지가 이미 SSH임을 알리므로 스킴 반복은 소음이다). 로컬 경로는 그대로.
 */
export function displayWorkspacePath(path: string): string {
  return isRemoteWorkspace(path) ? path.slice("ssh://".length) : path;
}
