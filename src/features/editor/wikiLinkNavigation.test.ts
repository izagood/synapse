import { describe, expect, it } from "vitest";
import { resolveWikiTarget } from "./wikiLinkNavigation";
import type { FileNode } from "../../ipc/types";

const makeTree = (files: { name: string; path: string }[]): FileNode => {
  const byDir = new Map<string, FileNode[]>();
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push({ name, path: f.path, kind: "file", fileType: "markdown" });
  }
  const root: FileNode = { name: "root", path: "/vault", kind: "dir", fileType: "other", children: [] };
  for (const [dir, nodes] of byDir) {
    const parts = dir.split("/").filter(Boolean);
    let current = root;
    for (const part of parts) {
      let child = current.children?.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: `/vault/${part}`, kind: "dir", fileType: "other", children: [] };
        current.children = current.children || [];
        current.children.push(child);
      }
      current = child as FileNode;
    }
    current.children = current.children || [];
    current.children.push(...nodes);
  }
  return root;
};

describe("resolveWikiTarget", () => {
  const tree = makeTree([
    { name: "README.md", path: "/vault/README.md" },
    { name: "00-목차.md", path: "/vault/00-목차.md" },
    { name: "notes.md", path: "/vault/notes.md" },
    { name: "NoteA.md", path: "/vault/notes/NoteA.md" },
    { name: "noteB.md", path: "/vault/notes/noteB.md" },
  ]);

  it("resolves simple target", () => {
    const result = resolveWikiTarget("00-목차", tree);
    expect(result?.path).toBe("/vault/00-목차.md");
    expect(result?.ambiguous).toBe(false);
  });

  it("is case-insensitive", () => {
    const result = resolveWikiTarget("NOTEa", tree);
    expect(result?.path).toBe("/vault/notes/NoteA.md");
  });

  it("strips alias and resolves", () => {
    const result = resolveWikiTarget("00-목차|목차로", tree);
    expect(result?.path).toBe("/vault/00-목차.md");
  });

  it("strips anchor and resolves", () => {
    const result = resolveWikiTarget("notes#section", tree);
    expect(result?.path).toBe("/vault/notes.md");
  });

  it("returns ambiguous when multiple files have same stem", () => {
    const tree2 = makeTree([
      { name: "note.md", path: "/vault/note.md" },
      { name: "Note.md", path: "/vault/Note.md" },
    ]);
    const result = resolveWikiTarget("note", tree2);
    expect(result?.ambiguous).toBe(true);
  });

  it("returns null for non-existent target", () => {
    const result = resolveWikiTarget("nonExistent", tree);
    expect(result).toBeNull();
  });

  it("handles empty inner", () => {
    const result = resolveWikiTarget("", tree);
    expect(result).toBeNull();
  });

  it("handles whitespace-only target after stripping", () => {
    const result = resolveWikiTarget("  |alias", tree);
    expect(result).toBeNull();
  });
});