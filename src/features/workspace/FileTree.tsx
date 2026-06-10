import { useState } from "react";
import type { FileNode } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";

const FILE_ICONS: Record<string, string> = {
  markdown: "📝",
  html: "🌐",
  other: "📄",
};

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const selectedPath = useWorkspace((s) => s.selectedPath);
  const selectFile = useWorkspace((s) => s.selectFile);

  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.kind === "dir") {
    return (
      <div>
        <button
          className="tree-row tree-dir"
          style={indent}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="tree-caret">{expanded ? "▾" : "▸"}</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {expanded &&
          node.children?.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
      </div>
    );
  }

  return (
    <button
      className={`tree-row tree-file${selectedPath === node.path ? " selected" : ""}`}
      style={indent}
      onClick={() => void selectFile(node)}
    >
      <span className="tree-icon">{FILE_ICONS[node.fileType]}</span>
      <span className="tree-name">{node.name}</span>
    </button>
  );
}

export function FileTree() {
  const tree = useWorkspace((s) => s.tree);
  if (!tree) return null;

  return (
    <nav className="file-tree">
      {tree.children?.length ? (
        tree.children.map((child) => (
          <TreeNode key={child.path} node={child} depth={0} />
        ))
      ) : (
        <p className="tree-empty">빈 폴더입니다</p>
      )}
    </nav>
  );
}
