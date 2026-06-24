import { beforeEach, describe, expect, it } from "vitest";
import { useUpdate } from "./update";
import { mockSyncControl } from "../ipc/mock";

describe("update store (mock ipc)", () => {
  beforeEach(() => {
    mockSyncControl.updateAvailable = null;
    useUpdate.setState({
      current: "",
      available: null,
      dismissedVersion: null,
      checking: false,
      installing: false,
      checked: false,
      error: null,
    });
  });

  it("reports up to date when no update exists", async () => {
    await useUpdate.getState().check();
    const s = useUpdate.getState();
    expect(s.checked).toBe(true);
    expect(s.available).toBeNull();
    expect(s.current).toBe("0.2.0-dev");
  });

  it("surfaces an available version and installs it", async () => {
    mockSyncControl.updateAvailable = "0.3.0";
    await useUpdate.getState().check();
    expect(useUpdate.getState().available).toBe("0.3.0");

    await useUpdate.getState().install();
    // mock 설치 후 더는 업데이트가 없어야 한다
    await useUpdate.getState().check();
    expect(useUpdate.getState().available).toBeNull();
  });

  it("install without available update is a no-op", async () => {
    await useUpdate.getState().install();
    expect(useUpdate.getState().error).toBeNull();
  });

  it("dismiss suppresses the dismissed version but not a newer one", async () => {
    mockSyncControl.updateAvailable = "0.3.0";
    await useUpdate.getState().check();
    useUpdate.getState().dismiss();
    expect(useUpdate.getState().dismissedVersion).toBe("0.3.0");

    // 같은 버전이 다시 확인돼도 억제 상태 유지
    await useUpdate.getState().check();
    let s = useUpdate.getState();
    expect(s.available).toBe(s.dismissedVersion);

    // 더 새로운 버전이 나오면 다시 알릴 수 있어야 한다 (available ≠ dismissedVersion)
    mockSyncControl.updateAvailable = "0.4.0";
    await useUpdate.getState().check();
    s = useUpdate.getState();
    expect(s.available).toBe("0.4.0");
    expect(s.available).not.toBe(s.dismissedVersion);
  });

  it("re-checks on every call and surfaces a newly published version", async () => {
    await useUpdate.getState().check();
    expect(useUpdate.getState().available).toBeNull();

    // 포커스 복귀 등으로 다시 확인하면 그 사이 올라온 새 버전을 발견한다
    mockSyncControl.updateAvailable = "0.4.0";
    await useUpdate.getState().check();
    const s = useUpdate.getState();
    expect(s.checked).toBe(true);
    expect(s.available).toBe("0.4.0");
  });
});
