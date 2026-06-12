import { beforeEach, describe, expect, it } from "vitest";
import { ipc } from "./ipc";
import { mockAgentControl } from "./mock";

// 2-D: API 키는 키체인(여기선 mock)에만 저장되고, 값은 노출되지 않으며
// 존재 여부만 조회할 수 있다.
describe("agent API key (mock keychain)", () => {
  beforeEach(() => {
    mockAgentControl.apiKey = null;
  });

  it("starts with no stored key", async () => {
    expect(await ipc.hasAgentApiKey()).toBe(false);
  });

  it("stores a key and reports presence (without exposing it)", async () => {
    await ipc.setAgentApiKey("sk-ant-secret");
    expect(await ipc.hasAgentApiKey()).toBe(true);
    expect(mockAgentControl.apiKey).toBe("sk-ant-secret");
  });

  it("trims whitespace around the key", async () => {
    await ipc.setAgentApiKey("  sk-ant-trim  ");
    expect(mockAgentControl.apiKey).toBe("sk-ant-trim");
  });

  it("rejects an empty key", async () => {
    await expect(ipc.setAgentApiKey("   ")).rejects.toThrow();
    expect(await ipc.hasAgentApiKey()).toBe(false);
  });

  it("clears the stored key (idempotent)", async () => {
    await ipc.setAgentApiKey("sk-ant-x");
    await ipc.clearAgentApiKey();
    expect(await ipc.hasAgentApiKey()).toBe(false);
    // 다시 지워도 오류 없음
    await expect(ipc.clearAgentApiKey()).resolves.toBeUndefined();
  });
});
