import { describe, expect, it, vi } from "vitest";
import { exportPathToOS } from "./dragExport";
import { ipc } from "../../ipc/ipc";

// 네이티브 드래그아웃(startDrag) 자체는 Tauri 런타임에서만 동작하므로
// 수동 검증 대상이다. 여기서는 비 Tauri/원격 경로에서 안전하게 무동작하는지만
// 단위로 검증한다(아이콘 조회조차 하지 않아야 한다).
describe("exportPathToOS 가드", () => {
  it("비 Tauri 환경에선 아이콘 조회도 드래그도 하지 않는다", async () => {
    const spy = vi.spyOn(ipc, "dragIconPath");
    await expect(exportPathToOS("/ws/note.md")).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("원격(ssh://) 경로는 무동작", async () => {
    const spy = vi.spyOn(ipc, "dragIconPath");
    await expect(exportPathToOS("ssh://host/ws/note.md")).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
