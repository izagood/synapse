import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileNode } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { useSettings } from "../../stores/settings";
import { ChevronIcon, FileIcon, FileTextIcon, GlobeIcon } from "../../shared/Icons";
import { clampMenuPosition, findNode, isDeleteShortcut } from "./fileTreeUtils";

// jsdom 등 scrollIntoView가 없는 환경 대비 옵셔널 호출
const scrollToRow = (el: HTMLButtonElement | null) =>
  el?.scrollIntoView?.({ block: "nearest" });

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
  const expanded = useWorkspace((s) => !!s.expandedDirs[node.path]);
  const toggleDir = useWorkspace((s) => s.toggleDir);
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
          onClick={() => toggleDir(node.path)}
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

  const selected = activePath === node.path;
  return (
    <button
      // selected로 마운트/전환되는 순간 보이는 위치로 스크롤 (이미 보이면 no-op).
      // 조상 펼침(revealPath)과 같은 렌더 패스에서 DOM이 생기므로 ref 시점이 안전하다.
      ref={selected ? scrollToRow : undefined}
      className={`tree-row tree-file${selected ? " selected" : ""}`}
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
  onDelete,
}: {
  menu: MenuState;
  onClose: () => void;
  onDialog: (d: DialogState) => void;
  onDelete: (node: FileNode) => void;
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

  // 메뉴가 창 밖으로 넘치면 안쪽으로 밀어 넣는다 (하단에서 '삭제'가 짤리던 문제)
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        menu.x,
        menu.y,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [menu]);

  const { node } = menu;
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
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
      <button className="context-danger" onClick={() => run(() => onDelete(node))}>
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
  const updateSettings = useSettings((s) => s.update);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const confirm = () => {
    if (dontAskAgain) {
      const files = useSettings.getState().settings.files;
      void updateSettings({ files: { ...files, confirmDelete: false } });
    }
    void deleteEntry(node);
    onClose();
  };

  // Enter = 삭제, Escape = 취소 (포커스 위치와 무관하게 동작)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

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
            Enter 키로 바로 삭제할 수 있습니다.
          </span>
        </p>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
          />
          <span>
            다시 묻지 않고 바로 삭제 <span className="modal-hint">(설정에서 되돌릴 수 있음)</span>
          </span>
        </label>
        <div className="modal-actions">
          <button ref={confirmRef} className="danger-btn" onClick={confirm}>
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

  // 컨텍스트 메뉴·단축키 공통 삭제 진입점 — 설정에 따라 확인 없이 바로 삭제
  const requestDelete = useCallback((node: FileNode) => {
    if (useSettings.getState().settings.files.confirmDelete) {
      setDialog({ kind: "delete", node });
    } else {
      void useWorkspace.getState().deleteEntry(node);
    }
  }, []);

  // Cmd/Ctrl+Backspace(또는 Delete)로 선택된 파일 삭제
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isDeleteShortcut(e)) return;
      // 에디터·입력창에 포커스가 있을 땐 글자 삭제 동작을 방해하지 않는다
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=\"true\"]")) return;
      if (dialog) return; // 다이얼로그가 떠 있으면 중복 트리거 방지
      const { tree, activePath } = useWorkspace.getState();
      if (!tree || !activePath) return;
      const node = findNode(tree, activePath);
      if (!node) return;
      e.preventDefault();
      requestDelete(node);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, requestDelete]);

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
          onDelete={requestDelete}
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
