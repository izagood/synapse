import { useState } from "react";
import type { FileNode } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { ChevronIcon, FileIcon, FileTextIcon, GlobeIcon } from "../../shared/Icons";

function FileTypeIcon({ node }: { node: FileNode }) {
  const size = 14;
  if (node.fileType === "markdown") return <FileTextIcon size={size} />;
  if (node.fileType === "html") return <GlobeIcon size={size} />;
  return <FileIcon size={size} />;
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const activePath = useWorkspace((s) => s.activePath);
  const openFile = useWorkspace((s) => s.openFile);

  if (node.kind === "dir") {
    return (
      <div className="tree-group">
        <button className="tree-row tree-dir" onClick={() => setExpanded((v) => !v)}>
          <span className={`tree-caret${expanded ? " expanded" : ""}`}>
            <ChevronIcon size={12} />
          </span>
          <span className="tree-name">{node.name}</span>
        </button>
        {expanded && (
          // 옵시디언 스타일 인덴트 가이드: 자식 컨테이너의 왼쪽 세로선
          <div className="tree-children">
            {node.children?.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      className={`tree-row tree-file${activePath === node.path ? " selected" : ""}`}
      onClick={() => void openFile(node)}
      title={node.name}
    >
      <span className="tree-icon">
        <FileTypeIcon node={node} />
      </span>
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
