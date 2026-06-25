/**
 * 원격 디렉토리 브라우저용 `ssh://` URI 분해/조합 헬퍼.
 *
 * 해소된 원격 루트는 `ssh://user@host[:port]/abs/path` 형태다. 브라우저는
 * 권한부(authority)는 고정한 채 POSIX 경로 부분만 오르내리므로, 둘을 나눠
 * 다루는 작은 순수 함수들을 모았다(테스트 가능, IPv6 대괄호 호스트 포함).
 */

/** `ssh://` URI를 권한부(base)와 POSIX 경로(path)로 나눈다. */
export function splitRemoteUri(uri: string): { base: string; path: string } {
  const scheme = "ssh://";
  if (!uri.startsWith(scheme)) {
    return { base: uri, path: "/" };
  }
  // 권한부 다음의 첫 "/" 가 경로의 시작. (IPv6 리터럴은 대괄호 안이라 영향 없음)
  const slash = uri.indexOf("/", scheme.length);
  if (slash === -1) {
    return { base: uri, path: "/" };
  }
  const path = uri.slice(slash);
  return { base: uri.slice(0, slash), path: path === "" ? "/" : path };
}

/** 권한부(base)와 POSIX 경로를 다시 `ssh://` URI로 합친다. */
export function joinRemoteUri(base: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/** POSIX 경로의 부모. 루트("/")의 부모는 자기 자신. */
export function posixDirname(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/** POSIX 경로에 자식 세그먼트 하나를 잇는다. */
export function posixJoin(base: string, name: string): string {
  if (base === "" || base === "/") return `/${name}`;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${b}/${name}`;
}
