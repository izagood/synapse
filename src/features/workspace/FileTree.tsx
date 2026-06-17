import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileNode } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { useSettings } from "../../stores/settings";
import { useHistoryUi } from "../history/historyStore";
import { useT } from "../../i18n";
import {
  ChevronIcon,
  DiagramIcon,
  FileIcon,
  FilePdfIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  PencilIcon,
} from "../../shared/Icons";
import { clampMenuPosition, findNode, isDeleteShortcut } from "./fileTreeUtils";
import { ipc } from "../../ipc/ipc";
import { detectDesktopPlatform } from "../../shared/platform";

// OS별로 "파일 매니저에서 보기" 라벨을 고른다 (macOS=Finder, Windows=탐색기)
function revealLabelKey(): "fileTree.revealInFinder" | "fileTree.revealInExplorer" | "fileTree.revealInFileManager" {
  switch (detectDesktopPlatform()) {
    case "macos":
      return "fileTree.revealInFinder";
    case "windows":
      return "fileTree.revealInExplorer";
    default:
      return "fileTree.revealInFileManager";
  }
}

// jsdom 등 scrollIntoView가 없는 환경 대비 옵셔널 호출
const scrollToRow = (el: HTMLButtonElement | null) =>
  el?.scrollIntoView?.({ block: "nearest" });

function FileTypeIcon({ node }: { node: FileNode }) {
  const size = 14;
  if (node.fileType === "markdown") return <FileTextIcon size={size} />;
  if (node.fileType === "html") return <GlobeIcon size={size} />;
  if (node.fileType === "pdf") return <FilePdfIcon size={size} />;
  if (node.fileType === "image") return <ImageIcon size={size} />;
  if (node.fileType === "drawio") return <DiagramIcon size={size} />;
  if (node.fileType === "excalidraw") return <PencilIcon size={size} />;
  return <FileIcon size={size} />;
}

interface MenuState {
  node: FileNode;
  x: number;
  y: number;
}

type DialogState = { kind: "delete"; node: FileNode } | null;

// 사이드바에서 파일/폴더 이름을 인라인으로 직접 수정하는 입력 (모달 대신)
function RenameInput({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const renameEntry = useWorkspace((s) => s.renameEntry);
  const [name, setName] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape 취소와 blur 커밋이 겹쳐 두 번 처리되는 것을 막는 가드
  const doneRef = useRef(false);

  useEffect(() => {
    // 확장자 앞까지만 선택 (VS Code 동작)
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = node.kind === "file" ? node.name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node]);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) {
      const trimmed = name.trim();
      if (trimmed && trimmed !== node.name) {
        void renameEntry(node, trimmed);
      }
    }
    onClose();
  };

  return (
    <input
      ref={inputRef}
      className="tree-rename-input"
      value={name}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      spellCheck={false}
    />
  );
}

function TreeNode({
  node,
  depth,
  onMenu,
  renaming,
  onRenameClose,
}: {
  node: FileNode;
  depth: number;
  onMenu: (menu: MenuState) => void;
  renaming: string | null;
  onRenameClose: () => void;
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

  const isRenaming = renaming === node.path;

  if (node.kind === "dir") {
    return (
      <div className="tree-group">
        {isRenaming ? (
          <div className="tree-row tree-dir">
            <span className={`tree-caret${expanded ? " expanded" : ""}`}>
              <ChevronIcon size={12} />
            </span>
            <RenameInput node={node} onClose={onRenameClose} />
          </div>
        ) : (
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
        )}
        {expanded && (
          // 옵시디언 스타일 인덴트 가이드: 자식 컨테이너의 왼쪽 세로선
          <div className="tree-children">
            {node.children?.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                onMenu={onMenu}
                renaming={renaming}
                onRenameClose={onRenameClose}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const selected = activePath === node.path;
  if (isRenaming) {
    return (
      <div className={`tree-row tree-file${selected ? " selected" : ""}`}>
        <span className="tree-icon">
          <FileTypeIcon node={node} />
        </span>
        <RenameInput node={node} onClose={onRenameClose} />
      </div>
    );
  }
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
  onRename,
  onDelete,
}: {
  menu: MenuState;
  onClose: () => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
}) {
  const createNote = useWorkspace((s) => s.createNote);
  const createDrawing = useWorkspace((s) => s.createDrawing);
  const createDrawioFile = useWorkspace((s) => s.createDrawioFile);
  const duplicateEntry = useWorkspace((s) => s.duplicateEntry);
  const openHistory = useHistoryUi((s) => s.open);
  const t = useT();

  const ref = useRef<HTMLDivElement>(null);

  // 메뉴 바깥을 누르거나 Esc를 누르면 닫는다.
  // 캡처 단계로 듣는 이유: 에디터(tiptap/ProseMirror) 같은 자식이 mousedown/click
  // 전파를 멈추면 버블 단계 window 리스너는 호출되지 않아 메뉴가 안 닫힌다.
  // 캡처 리스너는 자식보다 먼저 실행되므로 어디를 눌러도 항상 닫힌다.
  useEffect(() => {
    const onOutside = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return; // 메뉴 내부는 유지
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("contextmenu", onOutside, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("contextmenu", onOutside, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 메뉴가 창 밖으로 넘치면 안쪽으로 밀어 넣는다 (하단에서 '삭제'가 짤리던 문제)
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
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }}>
      {node.kind === "dir" && (
        <button onClick={() => run(() => void createNote(node.path))}>
          {t("fileTree.newNote")}
        </button>
      )}
      {node.kind === "dir" && (
        <button onClick={() => run(() => void createDrawing(node.path))}>
          {t("fileTree.newDrawing")}
        </button>
      )}
      {node.kind === "dir" && (
        <button onClick={() => run(() => void createDrawioFile(node.path))}>
          {t("fileTree.newDiagram")}
        </button>
      )}
      {node.kind === "file" && (
        <button onClick={() => run(() => void duplicateEntry(node))}>
          {t("fileTree.duplicate")}
        </button>
      )}
      <button onClick={() => run(() => onRename(node))}>
        {t("fileTree.rename")}
      </button>
      <button
        onClick={() => run(() => void navigator.clipboard?.writeText(node.path))}
      >
        {t("fileTree.copyPath")}
      </button>
      <button onClick={() => run(() => void ipc.revealPath(node.path))}>
        {t(revealLabelKey())}
      </button>
      {node.kind === "file" && (
        <button onClick={() => run(() => openHistory(node.path))}>
          {t("history.open")}
        </button>
      )}
      <div className="context-sep" />
      <button className="context-danger" onClick={() => run(() => onDelete(node))}>
        {t("fileTree.delete")}
      </button>
    </div>
  );
}

function DeleteDialog({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const deleteEntry = useWorkspace((s) => s.deleteEntry);
  const updateSettings = useSettings((s) => s.update);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const t = useT();

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
        <h2>{t("fileTree.deleteTitle")}</h2>
        <p>
          <strong>
            {node.kind === "dir"
              ? t("fileTree.deleteFolderPrompt", { name: node.name })
              : t("fileTree.deleteFilePrompt", { name: node.name })}
          </strong>
          <br />
          <span className="modal-hint">{t("fileTree.deleteHint")}</span>
        </p>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
          />
          <span>
            {t("fileTree.dontAskDelete")}{" "}
            <span className="modal-hint">{t("fileTree.canRestoreInSettings")}</span>
          </span>
        </label>
        <div className="modal-actions">
          <button ref={confirmRef} className="danger-btn" onClick={confirm}>
            {t("common.delete")}
          </button>
          <button onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

export function FileTree() {
  const tree = useWorkspace((s) => s.tree);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // 인라인 이름 변경 중인 노드 경로 (null이면 편집 안 함)
  const [renaming, setRenaming] = useState<string | null>(null);
  const t = useT();

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
          <TreeNode
            key={child.path}
            node={child}
            depth={0}
            onMenu={setMenu}
            renaming={renaming}
            onRenameClose={() => setRenaming(null)}
          />
        ))
      ) : (
        <p className="tree-empty">{t("fileTree.emptyFolder")}</p>
      )}
      {menu && (
        <TreeContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={(node) => setRenaming(node.path)}
          onDelete={requestDelete}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog node={dialog.node} onClose={() => setDialog(null)} />
      )}
    </nav>
  );
}
