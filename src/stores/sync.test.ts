import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeOf, useSync } from "./sync";
import { ipc } from "../ipc/ipc";
import { mockSyncControl } from "../ipc/mock";

const ROOT = "/mock/notes";

describe("sync store (mock ipc)", () => {
  beforeEach(() => {
    mockSyncControl.login = null;
    mockSyncControl.hasRemote = false;
    mockSyncControl.dirty = false;
    mockSyncControl.conflictOnNextSync = false;
    useSync.setState({
      login: null,
      status: null,
      device: null,
      loginError: null,
      syncing: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("device flow login: code shown, then polling succeeds", async () => {
    await useSync.getState().startLogin();
    expect(useSync.getState().device?.userCode).toBe("ABCD-1234");
    // mock은 두 번째 폴링에서 성공한다
    await vi.waitFor(() => {
      expect(useSync.getState().login).toBe("mock-user");
    });
    expect(useSync.getState().device).toBeNull();
  });

  it("publish connects the workspace and reports synced", async () => {
    mockSyncControl.login = "mock-user";
    await useSync.getState().refreshStatus(ROOT);
    expect(useSync.getState().status?.state).toBe("noRepo");

    await useSync.getState().publish(ROOT, "notes", true);
    expect(useSync.getState().status?.state).toBe("synced");
    expect(badgeOf(useSync.getState().status)).toBe("synced");
  });

  it("write → pending → syncNow → synced", async () => {
    mockSyncControl.login = "mock-user";
    mockSyncControl.hasRemote = true;
    await ipc.writeFile(ROOT, `${ROOT}/README.md`, "변경");

    await useSync.getState().refreshStatus(ROOT);
    expect(badgeOf(useSync.getState().status)).toBe("pending");

    await useSync.getState().syncNow(ROOT);
    expect(badgeOf(useSync.getState().status)).toBe("synced");
  });

  it("conflict surfaces files and resolves via choice", async () => {
    mockSyncControl.login = "mock-user";
    mockSyncControl.hasRemote = true;
    mockSyncControl.conflictOnNextSync = true;

    await useSync.getState().syncNow(ROOT);
    const status = useSync.getState().status;
    expect(status?.state).toBe("conflict");
    expect(status?.conflictFiles).toEqual(["README.md"]);

    await useSync.getState().resolveConflict(ROOT, "keepBoth");
    expect(useSync.getState().status?.state).toBe("synced");
  });

  it("publish without login surfaces the error", async () => {
    await expect(useSync.getState().publish(ROOT, "notes", true)).rejects.toBeTruthy();
    expect(useSync.getState().error).toContain("로그인");
  });

  it("logout clears the account", async () => {
    mockSyncControl.login = "mock-user";
    await useSync.getState().init();
    expect(useSync.getState().login).toBe("mock-user");
    await useSync.getState().logout();
    expect(useSync.getState().login).toBeNull();
  });
});
