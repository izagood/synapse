import { describe, expect, it } from "vitest";
import type { FileNode } from "../../ipc/types";
import {
  SYNAPSE_DND_MIME,
  dndKind,
  dropTargetDir,
  isRedundantOrInvalidMove,
} from "./dndUtils";

const ROOT = "/ws";
const dir: FileNode = { path: "/ws/sub", name: "sub", kind: "dir", fileType: "other" };
const file: FileNode = { path: "/ws/sub/a.md", name: "a.md", kind: "file", fileType: "markdown" };

describe("dropTargetDir", () => {
  it("폴더에 드롭하면 그 폴더가 대상", () => {
    expect(dropTargetDir(dir, ROOT)).toBe("/ws/sub");
  });
  it("파일에 드롭하면 그 파일의 부모 폴더가 대상", () => {
    expect(dropTargetDir(file, ROOT)).toBe("/ws/sub");
  });
  it("노드가 없으면 루트가 대상", () => {
    expect(dropTargetDir(null, ROOT)).toBe("/ws");
  });
});

describe("isRedundantOrInvalidMove", () => {
  it("이미 그 폴더에 있으면 무동작(true)", () => {
    expect(isRedundantOrInvalidMove("/ws/sub/a.md", "/ws/sub")).toBe(true);
  });
  it("폴더를 자기 자신 안으로는 불가(true)", () => {
    expect(isRedundantOrInvalidMove("/ws/sub", "/ws/sub")).toBe(true);
  });
  it("폴더를 자기 하위로는 불가(true)", () => {
    expect(isRedundantOrInvalidMove("/ws/sub", "/ws/sub/deep")).toBe(true);
  });
  it("다른 폴더로의 이동은 허용(false)", () => {
    expect(isRedundantOrInvalidMove("/ws/sub/a.md", "/ws/other")).toBe(false);
  });
  it("형제 폴더로의 폴더 이동은 허용(false)", () => {
    expect(isRedundantOrInvalidMove("/ws/sub", "/ws/other")).toBe(false);
  });
});

describe("dndKind", () => {
  it("내부 드래그 타입이 있으면 move", () => {
    expect(dndKind([SYNAPSE_DND_MIME])).toBe("move");
  });
  it("Files 가 있으면 import", () => {
    expect(dndKind(["Files"])).toBe("import");
  });
  it("내부 타입이 Files 보다 우선", () => {
    expect(dndKind([SYNAPSE_DND_MIME, "Files"])).toBe("move");
  });
  it("관련 타입이 없으면 null", () => {
    expect(dndKind(["text/plain"])).toBe(null);
  });
});
