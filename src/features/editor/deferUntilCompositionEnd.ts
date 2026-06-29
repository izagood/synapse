// 한글 IME 조합 도중 ProseMirror 문서를 변경하면(setContent 등) 진행 중
// composition이 바뀐 문서에 재조정되며 [본문 시작~커서] 구간이 삭제되어
// 문서가 붕괴한다. 조합이 끝날 때까지(수십 ms) 적용을 1회 연기한다.
//
// 반환: 조합 중이라 연기했다면 대기 리스너를 떼는 cleanup, 아니면 undefined.
export function deferUntilCompositionEnd(
  target: EventTarget,
  isComposing: boolean,
  apply: () => void,
): (() => void) | void {
  if (!isComposing) {
    apply();
    return;
  }
  const onEnd = () => {
    target.removeEventListener("compositionend", onEnd);
    apply();
  };
  target.addEventListener("compositionend", onEnd);
  return () => target.removeEventListener("compositionend", onEnd);
}
