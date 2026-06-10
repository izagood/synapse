import { describe, expect, it } from "vitest";
import type { FileNode } from "../../ipc/types";
import { filterQuickOpen, flattenFiles, fuzzyScore } from "./quickOpen";

const tree: FileNode = {
  name: "notes",
  path: "/ws",
  kind: "dir",
  fileType: "other",
  children: [
    {
      name: "daily",
      path: "/ws/daily",
      kind: "dir",
      fileType: "other",
      children: [
        { name: "2026-06-10.md", path: "/ws/daily/2026-06-10.md", kind: "file", fileType: "markdown" },
      ],
    },
    { name: "README.md", path: "/ws/README.md", kind: "file", fileType: "markdown" },
    { name: "회의록.md", path: "/ws/회의록.md", kind: "file", fileType: "markdown" },
  ],
};

describe("quick open", () => {
  it("flattens only files with relative paths", () => {
    const items = flattenFiles(tree);
    expect(items.map((i) => i.relPath)).toEqual([
      "daily/2026-06-10.md",
      "README.md",
      "회의록.md",
    ]);
  });

  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("rdme", "README.md")).not.toBeNull();
    expect(fuzzyScore("xyz", "README.md")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("ranks filename matches above scattered path matches", () => {
    const items = flattenFiles(tree);
    const result = filterQuickOpen(items, "readme");
    expect(result[0]?.relPath).toBe("README.md");
  });

  it("matches korean filenames", () => {
    const items = flattenFiles(tree);
    expect(filterQuickOpen(items, "회의")[0]?.relPath).toBe("회의록.md");
  });

  it("empty query lists everything up to the limit", () => {
    const items = flattenFiles(tree);
    expect(filterQuickOpen(items, "  ")).toHaveLength(3);
    expect(filterQuickOpen(items, "", 2)).toHaveLength(2);
  });
});
