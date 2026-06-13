import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeOf, useSync } from "./sync";
import { useSettings } from "./settings";
import { ipc } from "../ipc/ipc";
import { mockSyncControl } from "../ipc/mock";

const ROOT = "/mock/notes";

describe("sync store (mock ipc)", () => {
  beforeEach(() => {
    mockSyncControl.login = null;
    mockSyncControl.hasRemote = false;
    mockSyncControl.dirty = false;
    mockSyncControl.conflictOnNextSync = false;
    mockSyncControl.conflict = null;
    useSync.setState({
      login: null,
      status: null,
      conflictPreview: [],
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

    // diff 뷰 데이터(내 버전/원격 버전)가 함께 채워진다 (FR-4.5)
    const preview = useSync.getState().conflictPreview;
    expect(preview).toHaveLength(1);
    expect(preview[0].path).toBe("README.md");
    expect(preview[0].theirs).toContain("원격에서 고친 줄");

    await useSync.getState().resolveConflict(ROOT, "keepBoth");
    expect(useSync.getState().status?.state).toBe("synced");
    // 해결 후 diff 데이터는 비워진다
    expect(useSync.getState().conflictPreview).toEqual([]);
  });

  it("publish without login surfaces the error", async () => {
    await expect(useSync.getState().publish(ROOT, "notes", true)).rejects.toBeTruthy();
    expect(useSync.getState().error).toContain("로그인");
  });

  it("resetWorkspace clears stale status and error from the previous folder", async () => {
    useSync.setState({
      status: { state: "pending", ahead: 1, behind: 0, conflictFiles: [] },
      error: "git add 실패: index.lock",
      syncing: true,
    });
    useSync.getState().resetWorkspace();
    const s = useSync.getState();
    expect(s.status).toBeNull();
    expect(s.error).toBeNull();
    expect(s.syncing).toBe(false);
  });

  it("dismissError clears the footer error without touching status", () => {
    useSync.setState({
      status: { state: "synced", ahead: 0, behind: 0, conflictFiles: [] },
      error: "git push 실패: rejected (non-fast-forward)",
    });
    useSync.getState().dismissError();
    const s = useSync.getState();
    expect(s.error).toBeNull();
    expect(s.status?.state).toBe("synced");
  });

  it("autoLinkConfig: 연결되면 받아온 설정을 다시 읽어 반영한다", async () => {
    const autolink = vi.spyOn(ipc, "configSyncAutolink").mockResolvedValue({
      linked: true,
      repoName: "mock-user/synapse-config",
      sync: { state: "synced", ahead: 0, behind: 0, conflictFiles: [] },
    });
    const settingsInit = vi.spyOn(useSettings.getState(), "init").mockResolvedValue();

    await useSync.getState().autoLinkConfig();

    expect(autolink).toHaveBeenCalled();
    expect(settingsInit).toHaveBeenCalled();
  });

  it("autoLinkConfig: 가져올 레포가 없으면(미연결) 설정을 다시 읽지 않는다", async () => {
    vi.spyOn(ipc, "configSyncAutolink").mockResolvedValue({
      linked: false,
      repoName: null,
      sync: null,
    });
    const settingsInit = vi.spyOn(useSettings.getState(), "init").mockResolvedValue();

    await useSync.getState().autoLinkConfig();

    expect(settingsInit).not.toHaveBeenCalled();
  });

  it("autoLinkConfig: 자동 연결이 실패해도 조용히 무시한다", async () => {
    vi.spyOn(ipc, "configSyncAutolink").mockRejectedValue(new Error("network"));
    await expect(useSync.getState().autoLinkConfig()).resolves.toBeUndefined();
  });

  it("logout clears the account", async () => {
    mockSyncControl.login = "mock-user";
    await useSync.getState().init();
    expect(useSync.getState().login).toBe("mock-user");
    await useSync.getState().logout();
    expect(useSync.getState().login).toBeNull();
  });
});
