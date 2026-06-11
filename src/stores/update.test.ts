import { beforeEach, describe, expect, it } from "vitest";
import { UPDATE_RECHECK_INTERVAL_MS, useUpdate } from "./update";
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
      lastCheckedAt: null,
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

  it("recheckIfStale skips within the interval and rechecks after it", async () => {
    const t0 = 1_000_000;
    await useUpdate.getState().check(t0);
    expect(useUpdate.getState().lastCheckedAt).toBe(t0);

    // 간격 이내: 새 버전이 생겨도 다시 확인하지 않는다
    mockSyncControl.updateAvailable = "0.4.0";
    await useUpdate.getState().recheckIfStale(t0 + UPDATE_RECHECK_INTERVAL_MS - 1);
    expect(useUpdate.getState().available).toBeNull();

    // 간격 경과: 다시 확인해서 새 버전을 발견한다
    const t1 = t0 + UPDATE_RECHECK_INTERVAL_MS;
    await useUpdate.getState().recheckIfStale(t1);
    const s = useUpdate.getState();
    expect(s.available).toBe("0.4.0");
    expect(s.lastCheckedAt).toBe(t1);
  });

  it("recheckIfStale checks immediately when never checked before", async () => {
    mockSyncControl.updateAvailable = "0.4.0";
    await useUpdate.getState().recheckIfStale(123);
    const s = useUpdate.getState();
    expect(s.checked).toBe(true);
    expect(s.available).toBe("0.4.0");
  });
});
