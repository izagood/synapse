// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { FileNode } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { FileTree } from "./FileTree";

let root: Root | null = null;
let host: HTMLDivElement;

const README: FileNode = {
  path: "/tmp/notes/README.md",
  name: "README.md",
  kind: "file",
  fileType: "markdown",
};

const TREE: FileNode = {
  path: "/tmp/notes",
  name: "notes",
  kind: "dir",
  fileType: "other",
  children: [README],
};

function render() {
  root = createRoot(host);
  act(() => {
    root!.render(<FileTree />);
  });
}

// React 제어 input의 값을 바꾼다. value를 직접 대입하면 React가 변화를
// 감지하지 못하므로(자체 value 트래커) 네이티브 setter로 우회한 뒤 input 이벤트를 쏜다.
function typeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// 파일 행을 우클릭해 컨텍스트 메뉴를 띄우고 "이름 변경"을 클릭한다.
function startRename() {
  const row = host.querySelector(".tree-file") as HTMLElement;
  act(() => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
  const renameBtn = [...host.querySelectorAll(".context-menu button")].find(
    (b) => b.textContent === "이름 변경",
  ) as HTMLButtonElement;
  act(() => {
    renameBtn.click();
  });
}

describe("FileTree 인라인 이름 변경", () => {
  let renameEntry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    renameEntry = vi.fn(async () => {});
    useWorkspace.setState({
      tree: TREE,
      expandedDirs: {},
      activePath: null,
      renameEntry: renameEntry as never,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it("우클릭 메뉴에서 이름 변경 시 사이드바에 인라인 입력이 뜬다 (모달 없음)", () => {
    render();
    startRename();

    const input = host.querySelector(".tree-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    // 모달이 아니라 트리 행 안에서 편집된다
    expect(host.querySelector(".modal-backdrop")).toBeNull();
    expect(input.value).toBe("README.md");
  });

  it("Enter 입력 시 새 이름으로 renameEntry를 호출하고 입력을 닫는다", () => {
    render();
    startRename();

    const input = host.querySelector(".tree-rename-input") as HTMLInputElement;
    act(() => {
      typeValue(input, "소개.md");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(renameEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: README.path }),
      "소개.md",
    );
    expect(host.querySelector(".tree-rename-input")).toBeNull();
  });

  it("Escape 입력 시 이름을 바꾸지 않고 입력을 닫는다", () => {
    render();
    startRename();

    const input = host.querySelector(".tree-rename-input") as HTMLInputElement;
    act(() => {
      typeValue(input, "바뀌면안됨.md");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(renameEntry).not.toHaveBeenCalled();
    expect(host.querySelector(".tree-rename-input")).toBeNull();
  });
});
