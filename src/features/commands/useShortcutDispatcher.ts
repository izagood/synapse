import { useEffect } from "react";
import { matchShortcut, SHORTCUTS } from "../../shared/shortcuts";
import { executeCommand } from "./registry";

/**
 * 전역 단축키 디스패처 — 앱의 전역 keydown 리스너는 이것 하나만 둔다.
 * SHORTCUTS(handledBy:"app") 정의와 매칭되면 같은 id 의 커맨드를 실행한다.
 * 커맨드가 없거나 disabled 면 preventDefault 하지 않아 OS/웹뷰 기본
 * 동작(마지막 탭에서 ⌘W = 창 닫기 등)이 그대로 동작한다.
 */
export function dispatchShortcutEvent(e: KeyboardEvent): void {
  if (e.isComposing) return; // 한글 IME 조합 중 오발동 방지
  for (const def of SHORTCUTS) {
    if (def.handledBy !== "app") continue;
    if (!matchShortcut(e, def.keys)) continue;
    if (executeCommand(def.id)) e.preventDefault();
    return; // app 정의 간 키 중복은 없다 — 첫 매칭에서 종료
  }
}

export function useShortcutDispatcher(): void {
  useEffect(() => {
    window.addEventListener("keydown", dispatchShortcutEvent);
    return () => window.removeEventListener("keydown", dispatchShortcutEvent);
  }, []);
}
