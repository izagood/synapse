// 외부 파일 변경 → 자동 reload 배선.
//
// 수동 새로고침에만 의존하던 UX를 개선한다. 두 신호로 reload를 트리거한다:
//  1) OS 워처 이벤트(`workspace:files-changed`) — 외부 에디터/동기화로 파일이
//     바뀌면 백엔드가 emit (src-tauri/src/watcher.rs)
//  2) 창 포커스 복귀 — 워처가 놓친 변경의 안전망
//
// 두 신호 모두 한 번에 몰릴 수 있으므로(저장 한 번에 여러 이벤트, 대량 동기화),
// 디바운스 스케줄러로 묶어 reloadAfterSync 한 번으로 합친다. reloadAfterSync는
// 내용을 비교해 clean 문서만 디스크 내용으로 교체하고, dirty 문서는 디스크가
// 정말 발산했을 때만 배지(externalStale)를 세운다(저장 시 다음 저장이 3-way로
// 흡수). 앱 자신의 저장이 유발한 잉여 트리거가 와도 안전하다(no-op).

import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";

/** 변경 신호가 멎고 이만큼 조용하면 reload 한 번 실행한다. */
const RELOAD_DEBOUNCE_MS = 400;

/**
 * 여러 trigger() 호출을 조용해질 때까지 묶어 단 한 번 reload를 실행한다
 * (trailing debounce). 워처/포커스 신호 폭주를 한 번의 재로드로 합치는 용도.
 */
export function createReloadScheduler(reload: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reload();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** 로컬 워크스페이스 루트인지(OS 워처 대상). ssh:// 원격은 감시할 수 없다. */
export function isLocalRoot(root: string): boolean {
  return !root.startsWith("ssh://");
}

/**
 * 자동 reload 배선을 설치한다. 정리 함수를 반환하므로 useEffect에서 바로
 * 쓸 수 있다. 호출 시점의 워크스페이스 루트를 감시하고, 이후 루트 변경을
 * 추적해 워처를 교체한다.
 */
export function installFileWatch(): () => void {
  const scheduler = createReloadScheduler(() => {
    void useWorkspace.getState().reloadAfterSync();
  }, RELOAD_DEBOUNCE_MS);

  let disposed = false;
  let unlistenEvent: (() => void) | null = null;

  // 외부 변경 이벤트 → 디바운스 후 reload
  void ipc.onFilesChanged(() => scheduler.trigger()).then((un) => {
    if (disposed) un();
    else unlistenEvent = un;
  });

  // 루트에 따라 워처 시작/교체/중단 (로컬만 감시)
  const syncWatcher = (root: string | null) => {
    if (root && isLocalRoot(root)) {
      void ipc.startWatching(root).catch(() => undefined);
    } else {
      void ipc.stopWatching().catch(() => undefined);
    }
  };
  let lastRoot = useWorkspace.getState().root;
  syncWatcher(lastRoot);
  const unsubStore = useWorkspace.subscribe((s) => {
    if (s.root === lastRoot) return;
    lastRoot = s.root;
    syncWatcher(s.root);
  });

  // 창 포커스 복귀 시에도 한 번 reload (워처가 놓친 변경 안전망)
  const onFocus = () => {
    if (useWorkspace.getState().root) scheduler.trigger();
  };
  window.addEventListener("focus", onFocus);

  return () => {
    disposed = true;
    scheduler.cancel();
    unlistenEvent?.();
    unsubStore();
    window.removeEventListener("focus", onFocus);
    void ipc.stopWatching().catch(() => undefined);
  };
}
