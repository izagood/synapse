import { useEffect } from "react";
import { useUpdate } from "../../stores/update";

/**
 * 앱 시작 시 1회 + 창 포커스 복귀 시마다 업데이트를 자동 확인한다.
 * 워크스페이스의 토스트(UpdateToast)와 시작 화면의 푸터 바(StartUpdateBar)가
 * 같은 확인 로직을 공유한다 — check()의 checking 가드가 중복 호출을 막는다.
 */
export function useUpdateAutoCheck() {
  useEffect(() => {
    const s = useUpdate.getState();
    if (!s.checked) void s.check();
    const onFocus = () => void useUpdate.getState().check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
