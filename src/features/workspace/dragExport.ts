// 트리 항목을 OS(Finder/탐색기)로 끌어 내보내기 — 네이티브 드래그아웃.
// 웹뷰의 HTML5 드래그로는 OS로 실제 파일을 끌어낼 수 없어 tauri-plugin-drag의
// startDrag(네이티브 드래그 세션)를 쓴다. 내부 이동(HTML5 DnD)과 같은 제스처를
// 공유할 수 없으므로 호출부에서 ⌥(Alt) 수식키로 분기한다.
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ipc } from "../../ipc/ipc";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// startDrag는 icon(커서에 붙는 미리보기)이 필수다. 경로 조회는 IPC 왕복이라
// 드래그 시작 제스처를 놓치지 않도록 한 번만 받아 캐시하고, 앱에서는 미리 받아둔다.
let iconPathPromise: Promise<string> | null = null;
function iconPath(): Promise<string> {
  if (!iconPathPromise) iconPathPromise = ipc.dragIconPath();
  return iconPathPromise;
}

if (isTauri) void iconPath().catch(() => undefined); // 캐시 워밍업

/** 로컬 파일/폴더를 OS로 네이티브 드래그아웃한다. 비 Tauri·원격(ssh://)은 무동작. */
export async function exportPathToOS(absPath: string): Promise<void> {
  if (!isTauri || absPath.startsWith("ssh://")) return;
  try {
    const icon = await iconPath();
    await startDrag({ item: [absPath], icon });
  } catch {
    // 네이티브 드래그 시작 실패는 비치명적 — 조용히 무시한다(드래그가 안 될 뿐).
  }
}
