import { describe, expect, it, vi } from "vitest";
import { openWorkspacePath } from "./openPath";

describe("openWorkspacePath", () => {
  const makeActions = () => ({
    openFolder: vi.fn(),
    openRemote: vi.fn(),
  });

  it("로컬 절대 경로는 openFolder로 보낸다", () => {
    const actions = makeActions();
    expect(openWorkspacePath("/home/me/notes", actions)).toBe(true);
    expect(actions.openFolder).toHaveBeenCalledWith("/home/me/notes");
    expect(actions.openRemote).not.toHaveBeenCalled();
  });

  it("앞뒤 공백을 제거하고 연다", () => {
    const actions = makeActions();
    openWorkspacePath("  /home/me/notes \n", actions);
    expect(actions.openFolder).toHaveBeenCalledWith("/home/me/notes");
  });

  it("ssh:// URI는 openRemote로 보낸다 (무인증 재연결)", () => {
    const actions = makeActions();
    expect(openWorkspacePath("ssh://me@host/path", actions)).toBe(true);
    expect(actions.openRemote).toHaveBeenCalledWith("ssh://me@host/path", {
      acceptNewHostKey: false,
    });
    expect(actions.openFolder).not.toHaveBeenCalled();
  });

  it("빈 문자열/공백만 있으면 아무것도 하지 않고 false를 반환한다", () => {
    const actions = makeActions();
    expect(openWorkspacePath("   ", actions)).toBe(false);
    expect(actions.openFolder).not.toHaveBeenCalled();
    expect(actions.openRemote).not.toHaveBeenCalled();
  });
});
