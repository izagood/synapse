/**
 * 사용자가 입력/붙여넣은 경로 문자열을 적절한 워크스페이스 열기 액션으로 보낸다.
 * `ssh://`로 시작하면 원격(SSH)으로, 그 외에는 로컬 폴더로 연다.
 * 최근 목록 클릭과 동일한 분기를 쓰므로 두 진입점의 동작이 항상 일치한다.
 *
 * @returns 디스패치했으면 true, 입력이 비어 있어 아무것도 하지 않았으면 false.
 */
export function openWorkspacePath(
  path: string,
  actions: {
    openFolder: (p: string) => void;
    openRemote: (uri: string, opts: { acceptNewHostKey: boolean }) => void;
  },
): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("ssh://")) {
    // 최근 목록과 동일하게 무인증(에이전트/키) 재연결만 먼저 시도한다.
    // 비밀번호가 필요하면 "원격 폴더 열기" 폼으로 자격증명을 입력한다.
    actions.openRemote(trimmed, { acceptNewHostKey: false });
  } else {
    actions.openFolder(trimmed);
  }
  return true;
}
