// 한글 IME 조합 도중 ProseMirror 문서를 변경하면(setContent 등) 진행 중
// composition이 바뀐 문서에 재조정되며 [본문 시작~커서] 구간이 삭제되어
// 문서가 붕괴한다. 조합이 끝날 때까지 적용을 연기한다.
//
// 한글 연타는 음절마다 compositionend 직후 곧바로 compositionstart가 이어질
// 수 있다. 그래서 compositionend 1회로 조합이 끝났다고 단정하지 않고, 적용
// 직전에 getIsComposing으로 재확인해 새 조합이 시작됐으면 다음 compositionend를
// 다시 기다린다. 틱 폴링이나 횟수 제한이 아니라 이벤트 기반이라, 조합 중
// 적용은 어떤 경로로도 일어나지 않는다.
//
// 반환: 조합 중이라 연기했다면 대기 중인 적용을 취소하는 cleanup, 아니면 undefined.
export function deferUntilCompositionEnd(
  target: EventTarget,
  isComposing: boolean,
  apply: () => void,
  getIsComposing?: () => boolean,
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
    timer = setTimeout(applyOutsideComposition, 0);
  };
  const applyOutsideComposition = () => {
    if (getIsComposing?.()) {
      // 그 한 틱 사이에 새 조합이 시작됐다(연타) — 다음 조합 종료를 다시 기다린다.
      target.addEventListener("compositionend", onEnd);
      return;
    }
    apply();
  };
  target.addEventListener("compositionend", onEnd);
  return () => {
    target.removeEventListener("compositionend", onEnd);
    if (timer !== undefined) clearTimeout(timer);
  };
}
