import { beforeEach, describe, expect, it } from "vitest";
import { useUpdate } from "./update";
import { mockSyncControl } from "../ipc/mock";

describe("update store (mock ipc)", () => {
  beforeEach(() => {
    mockSyncControl.updateAvailable = null;
    useUpdate.setState({
      current: "",
      available: null,
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
});
