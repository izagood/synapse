// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_SETTINGS } from "../../ipc/types";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../ipc/ipc";
import { RemoteBrowser } from "./RemoteBrowser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLDivElement;

const HOME = "ssh://me@host/home/me";

function render(homeUri = HOME) {
  root = createRoot(host);
  act(() => {
    root!.render(<RemoteBrowser homeUri={homeUri} onCancel={() => {}} />);
  });
}

/** listRemoteDir 등 비동기 상태 갱신이 커밋되도록 마이크로태스크를 비운다. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function pathInput(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>("input.remote-browser-path");
  expect(el).not.toBeNull();
  return el!;
}

function setPath(el: HTMLInputElement, value: string) {
  act(() => {
    // React 제어 입력은 네이티브 setter로 값을 넣고 input 이벤트를 흘려야 반영된다.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("RemoteBrowser", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: true,
      showSettings: false,
    });
    useWorkspace.setState({ loading: false, error: null });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
    vi.restoreAllMocks();
  });

  it("isDir=true 항목은 클릭 가능한 폴더 버튼으로, 파일은 비클릭으로 렌더링한다", async () => {
    const list = vi
      .spyOn(ipc, "listRemoteDir")
      .mockResolvedValue([
        { name: "notes", isDir: true },
        { name: "readme.md", isDir: false },
      ]);
    render();
    await flush();

    const buttons = [
      ...host.querySelectorAll<HTMLButtonElement>(
        "button.remote-browser-entry:not(.remote-browser-up)",
      ),
    ];
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining("notes"),
    ]);
    expect(
      host.querySelector(".remote-browser-file")?.textContent,
    ).toContain("readme.md");

    // 폴더 클릭 → 하위 경로를 다시 나열한다
    act(() => {
      buttons[0].click();
    });
    await flush();
    expect(list).toHaveBeenLastCalledWith("ssh://me@host/home/me/notes");
  });

  it("경로 입력 후 Enter로 해당 디렉터리로 이동한다", async () => {
    const list = vi.spyOn(ipc, "listRemoteDir").mockResolvedValue([]);
    render();
    await flush();

    const input = pathInput();
    expect(input.value).toBe("/home/me");

    setPath(input, "/srv/notes/");
    pressKey(input, "Enter");
    await flush();

    // 끝 슬래시는 정규화되어 URI에 반영된다
    expect(list).toHaveBeenLastCalledWith("ssh://me@host/srv/notes");
    expect(input.value).toBe("/srv/notes");
  });

  it("상대 경로 입력은 절대 경로로 보정하고, Escape는 현재 경로로 되돌린다", async () => {
    const list = vi.spyOn(ipc, "listRemoteDir").mockResolvedValue([]);
    render();
    await flush();

    const input = pathInput();
    setPath(input, "var/log");
    pressKey(input, "Enter");
    await flush();
    expect(list).toHaveBeenLastCalledWith("ssh://me@host/var/log");

    setPath(input, "/tmp/whatever");
    pressKey(input, "Escape");
    expect(input.value).toBe("/var/log");
    // Escape는 이동을 트리거하지 않는다
    expect(list).toHaveBeenLastCalledWith("ssh://me@host/var/log");
  });

  it("빈 입력에서 Enter를 치면 이동하지 않고 현재 경로를 복원한다", async () => {
    const list = vi.spyOn(ipc, "listRemoteDir").mockResolvedValue([]);
    render();
    await flush();
    const callsBefore = list.mock.calls.length;

    const input = pathInput();
    setPath(input, "   ");
    pressKey(input, "Enter");
    await flush();

    expect(input.value).toBe("/home/me");
    expect(list.mock.calls.length).toBe(callsBefore);
  });
});
