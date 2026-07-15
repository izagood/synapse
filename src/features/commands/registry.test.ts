import { describe, expect, it, vi } from "vitest";
import {
  executeCommand,
  getCommand,
  registerCommand,
  useCommandRegistry,
  type CommandDef,
} from "./registry";

function def(id: string, run: CommandDef["run"] = vi.fn()): CommandDef {
  return { id, titleKey: "tabs.close", category: "file", run };
}

describe("command registry", () => {
  it("등록·실행·해제", () => {
    const run = vi.fn();
    const off = registerCommand(def("t.a", run));
    expect(executeCommand("t.a")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    off();
    expect(getCommand("t.a")).toBeUndefined();
    expect(executeCommand("t.a")).toBe(false);
  });

  it("중복 id는 최신 등록이 이긴다 — 이전 해제 함수는 최신 것을 지우지 않는다", () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    const off1 = registerCommand(def("t.dup", r1));
    const off2 = registerCommand(def("t.dup", r2));
    executeCommand("t.dup");
    expect(r2).toHaveBeenCalledOnce();
    expect(r1).not.toHaveBeenCalled();
    off1(); // 자기 def가 아니므로 no-op
    expect(getCommand("t.dup")).toBeDefined();
    off2();
    expect(getCommand("t.dup")).toBeUndefined();
  });

  it("enabled()가 false면 실행하지 않고 false를 반환한다", () => {
    const run = vi.fn();
    const off = registerCommand({ ...def("t.dis", run), enabled: () => false });
    expect(executeCommand("t.dis")).toBe(false);
    expect(run).not.toHaveBeenCalled();
    off();
  });

  it("run이 reject해도 executeCommand는 throw하지 않는다", () => {
    const off = registerCommand(def("t.rej", () => Promise.reject(new Error("boom"))));
    expect(() => executeCommand("t.rej")).not.toThrow();
    off();
  });

  it("스토어 구독으로 커맨드 목록 변화를 감지할 수 있다", () => {
    const before = Object.keys(useCommandRegistry.getState().commands).length;
    const off = registerCommand(def("t.sub"));
    expect(Object.keys(useCommandRegistry.getState().commands).length).toBe(before + 1);
    off();
    expect(Object.keys(useCommandRegistry.getState().commands).length).toBe(before);
  });
});
