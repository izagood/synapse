import { useEffect, useRef, useState } from "react";
import type { FileNode } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { ChevronIcon, FileIcon, FileTextIcon, GlobeIcon } from "../../shared/Icons";

function FileTypeIcon({ node }: { node: FileNode }) {
  const size = 14;
  if (node.fileType === "markdown") return <FileTextIcon size={size} />;
  if (node.fileType === "html") return <GlobeIcon size={size} />;
  return <FileIcon size={size} />;
}

interface MenuState {
  node: FileNode;
  x: number;
  y: number;
}

type DialogState =
  | { kind: "rename"; node: FileNode }
  | { kind: "delete"; node: FileNode }
  | null;

function TreeNode({
  node,
  depth,
  onMenu,
}: {
  node: FileNode;
  depth: number;
  onMenu: (menu: MenuState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const activePath = useWorkspace((s) => s.activePath);
  const openFile = useWorkspace((s) => s.openFile);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu({ node, x: e.clientX, y: e.clientY });
  };

  if (node.kind === "dir") {
    return (
      <div className="tree-group">
        <button
          className="tree-row tree-dir"
          onClick={() => setExpanded((v) => !v)}
          onContextMenu={handleContextMenu}
        >
          <span className={`tree-caret${expanded ? " expanded" : ""}`}>
            <ChevronIcon size={12} />
          </span>
          <span className="tree-name">{node.name}</span>
        </button>
        {expanded && (
          // 옵시디언 스타일 인덴트 가이드: 자식 컨테이너의 왼쪽 세로선
          <div className="tree-children">
            {node.children?.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} onMenu={onMenu} />
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
      onContextMenu={handleContextMenu}
      title={node.name}
    >
      <span className="tree-icon">
        <FileTypeIcon node={node} />
      </span>
      <span className="tree-name">{node.name}</span>
    </button>
  );
}

// VS Code 스타일 파일/폴더 우클릭 메뉴 (FR-1.3)
function TreeContextMenu({
  menu,
  onClose,
  onDialog,
}: {
  menu: MenuState;
  onClose: () => void;
  onDialog: (d: DialogState) => void;
}) {
  const createNote = useWorkspace((s) => s.createNote);
  const duplicateEntry = useWorkspace((s) => s.duplicateEntry);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [onClose]);

  const { node } = menu;
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {node.kind === "dir" && (
        <button onClick={() => run(() => void createNote(node.path))}>새 노트</button>
      )}
      {node.kind === "file" && (
        <button onClick={() => run(() => void duplicateEntry(node))}>사본 만들기</button>
      )}
      <button onClick={() => run(() => onDialog({ kind: "rename", node }))}>
        이름 변경
      </button>
      <button
        onClick={() => run(() => void navigator.clipboard?.writeText(node.path))}
      >
        경로 복사
      </button>
      <div className="context-sep" />
      <button
        className="context-danger"
        onClick={() => run(() => onDialog({ kind: "delete", node }))}
      >
        삭제
      </button>
    </div>
  );
}

function RenameDialog({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const renameEntry = useWorkspace((s) => s.renameEntry);
  const [name, setName] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 파일명 선택 시 확장자 앞까지만 선택 (VS Code 동작)
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = node.kind === "file" ? node.name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node]);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== node.name) {
      void renameEntry(node, trimmed);
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rename-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>이름 변경</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          spellCheck={false}
        />
        <div className="modal-actions">
          <button className="primary-btn" onClick={submit}>
            변경
          </button>
          <button onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const deleteEntry = useWorkspace((s) => s.deleteEntry);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>삭제</h2>
        <p>
          <strong>{node.name}</strong>
          {node.kind === "dir" ? " 폴더와 안의 모든 파일을" : "을(를)"} 삭제할까요?
          <br />
          <span className="modal-hint">
            이 작업은 되돌릴 수 없습니다 (GitHub에 동기화된 내용은 히스토리에 남습니다).
          </span>
        </p>
        <div className="modal-actions">
          <button
            className="danger-btn"
            onClick={() => {
              void deleteEntry(node);
              onClose();
            }}
          >
            삭제
          </button>
          <button onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}

export function FileTree() {
  const tree = useWorkspace((s) => s.tree);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  if (!tree) return null;

  return (
    <nav className="file-tree">
      {tree.children?.length ? (
        tree.children.map((child) => (
          <TreeNode key={child.path} node={child} depth={0} onMenu={setMenu} />
        ))
      ) : (
        <p className="tree-empty">빈 폴더입니다</p>
      )}
      {menu && (
        <TreeContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onDialog={setDialog}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog node={dialog.node} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog node={dialog.node} onClose={() => setDialog(null)} />
      )}
    </nav>
  );
}
