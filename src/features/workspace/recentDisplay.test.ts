import { describe, expect, it } from "vitest";
import { displayWorkspacePath, isRemoteWorkspace } from "./recentDisplay";

describe("recentDisplay", () => {
  it("detects remote ssh workspaces", () => {
    expect(isRemoteWorkspace("ssh://me@host/srv/notes")).toBe(true);
    expect(isRemoteWorkspace("/Users/me/notes")).toBe(false);
    // 로컬 폴더 이름에 ssh가 들어가도 원격으로 오인하지 않는다
    expect(isRemoteWorkspace("/Users/me/ssh-notes")).toBe(false);
  });

  it("strips the ssh scheme for display and keeps local paths as-is", () => {
    expect(displayWorkspacePath("ssh://me@host:2222/srv/notes")).toBe(
      "me@host:2222/srv/notes",
    );
    expect(displayWorkspacePath("/Users/me/notes")).toBe("/Users/me/notes");
  });
});
