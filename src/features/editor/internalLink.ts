// 마크다운 링크의 상대 경로를 vault 내 절대 경로로 해석한다 (FR: 내부 링크 이동).
// 외부 링크(스킴 있는 URL)·문서 내 앵커·vault 밖으로 나가는 경로는 null.

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * @param href 마크다운 링크의 href (예: "../00-목차.md", "./하위/노트.md#섹션")
 * @param currentPath 링크가 있는 문서의 절대 경로
 * @param root vault 루트의 절대 경로
 * @returns 해석된 절대 경로, 내부 파일 링크가 아니면 null
 */
export function resolveInternalLink(
  href: string,
  currentPath: string,
  root: string,
): string | null {
  if (!href || href.startsWith("#")) return null; // 문서 내 앵커
  if (SCHEME_RE.test(href) || href.startsWith("//")) return null; // http:, mailto: 등

  let target = href.split(/[?#]/)[0]; // 앵커·쿼리는 떼고 파일 경로만
  if (!target) return null;
  try {
    target = decodeURIComponent(target); // "%EB%AA%A9%EC%B0%A8.md" 같은 인코딩 복원
  } catch {
    // 잘못된 인코딩은 원문 그대로 사용
  }

  // 선행 "/"는 vault 루트 기준, 그 외에는 현재 문서의 폴더 기준
  const base = target.startsWith("/")
    ? root
    : currentPath.slice(0, currentPath.lastIndexOf("/"));
  const segments = base.split("/");
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const resolved = segments.join("/");
  if (!resolved.startsWith(`${root}/`)) return null; // vault 밖 탈출 금지
  return resolved;
}
