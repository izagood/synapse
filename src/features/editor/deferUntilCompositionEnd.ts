// 한글 IME 조합 도중 ProseMirror 문서를 변경하면(setContent 등) 진행 중
// composition이 바뀐 문서에 재조정되며 [본문 시작~커서] 구간이 삭제되어
// 문서가 붕괴한다. 조합이 끝날 때까지(수십 ms) 적용을 1회 연기한다.
//
// 반환: 조합 중이라 연기했다면 대기 중인 적용을 취소하는 cleanup, 아니면 undefined.
export function deferUntilCompositionEnd(
  target: EventTarget,
  isComposing: boolean,
  apply: () => void,
): (() => void) | void {
  if (!isComposing) {
    apply();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onEnd = () => {
    target.removeEventListener("compositionend", onEnd);
    // ProseMirror는 compositionend 시 view.composing을 동기적으로 false로
    // 바꾸지만 실제 composition 정리(flush)는 다음 틱으로 미룬다. 그 정리
    // 이후에 setContent가 적용되도록 한 틱(매크로태스크) 미뤄, PM이 아직
    // flush를 대기 중인 창에서 문서를 바꾸지 않게 한다.
    timer = setTimeout(apply, 0);
  };
  target.addEventListener("compositionend", onEnd);
  return () => {
    target.removeEventListener("compositionend", onEnd);
    if (timer !== undefined) clearTimeout(timer);
  };
}
