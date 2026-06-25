import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import {
  countShapes,
  emptyDrawDoc,
  eraseShapesAt,
  HIGHLIGHTER_OPACITY,
  isNonEmptyShape,
  newShapeId,
  parseDrawDoc,
  serializeDrawDoc,
  shapesOnPage,
  translateShape,
  type DrawDoc,
  type Shape,
  type ToolKind,
} from "./drawDoc";

const AUTOSAVE_MS = 800;
const UNDO_LIMIT = 60;
const DEFAULT_COLOR = "#e02424";
const DEFAULT_WIDTH = 3; // scale 1(pt) 기준
const RECENT_COLOR_LIMIT = 8;

export interface PdfDrawApi {
  tool: ToolKind;
  setTool: (t: ToolKind) => void;
  color: string;
  setColor: (c: string) => void;
  width: number;
  setWidth: (w: number) => void;
  /** 0..1 현재 불투명도(다음에 그릴 획에 적용). */
  opacity: number;
  setOpacity: (o: number) => void;
  /** 도형(rect/ellipse) 채우기 색. null 이면 투명(테두리만). */
  fill: string | null;
  setFill: (c: string | null) => void;
  /** 최근 사용한 색(중복 제거, 최신순). */
  recentColors: string[];

  /** 오버레이 재렌더 트리거용 리비전(개수 불변 편집·선택 포함). */
  revision: number;
  /** 현재 선택된 도형(select 도구). 없으면 null. */
  selection: { page: number; id: string } | null;
  selectShape: (page: number, id: string) => void;
  clearSelection: () => void;
  /** 선택 도형을 새 도형으로 교체(이동/리사이즈 commit). undo 가능. */
  updateShape: (page: number, id: string, next: Shape) => void;
  /** 선택 도형 삭제 */
  removeSelected: () => void;
  /** 선택 도형을 약간 어긋나게 복제하고 사본을 선택 */
  duplicateSelected: () => void;
  /** 선택 도형을 z-순서 맨 앞/뒤로 */
  bringSelectedToFront: () => void;
  sendSelectedToBack: () => void;

  /** 도구별 굵기(형광펜은 더 굵게)를 적용한 현재 획 굵기 */
  effectiveWidth: () => number;

  /** renderAll/오버레이가 동기적으로 읽는 현재 문서 */
  docRef: React.RefObject<DrawDoc>;
  /** 그리기 가능한 도구가 선택돼 있는지(move 아님) */
  isDrawing: boolean;

  shapeCount: number;
  dirty: boolean;

  /** 완성된 한 도형을 페이지에 커밋(undo 가능). 빈 도형은 무시. */
  commitShape: (page: number, shape: Shape) => void;
  /** (x,y) 반경에 닿는 도형 제거. 제거됐으면 true. */
  eraseAt: (page: number, x: number, y: number, radius: number) => boolean;
  /** 직전 변경 취소 */
  undo: () => void;
  /** 직전 취소를 다시 실행 */
  redo: () => void;
  /** redo 스택에 되돌릴 변경이 있는지 */
  canRedo: boolean;
  /** 한 페이지의 모든 도형 삭제 */
  clearPage: (page: number) => void;
  /** 전 페이지 모든 도형 삭제 */
  clearAll: () => void;

  /** 굽기 등 즉시 직렬화가 필요할 때의 현재 문서 */
  getDoc: () => DrawDoc;
}

interface UndoEntry {
  page: number;
  shapes: Shape[]; // 변경 직전 그 페이지의 도형 배열(얕은 사본)
}

/**
 * PDF 한 개의 드로잉 상태와 사이드카(JSON) 영속화를 담당한다.
 * 진행 중인(드래그 중) 도형은 뷰어가 들고 있고, 여기엔 "완성된" 도형만 커밋된다.
 */
export function usePdfDraw(path: string): PdfDrawApi {
  const root = useWorkspace((s) => s.root);

  const docRef = useRef<DrawDoc>(emptyDrawDoc());
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tool, setToolState] = useState<ToolKind>("move");
  const [color, setColorState] = useState(DEFAULT_COLOR);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [opacity, setOpacity] = useState(1);
  const [fill, setFill] = useState<string | null>(null);
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [shapeCount, setShapeCount] = useState(0);
  const [canRedo, setCanRedo] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{ page: number; id: string } | null>(null);

  const bumpRevision = useCallback(() => setRevision((r) => r + 1), []);

  // 도구를 고르면 그 도구의 기본 불투명도로 맞춘다(이후 슬라이더로 미세조정).
  const setTool = useCallback((t: ToolKind) => {
    setToolState(t);
    if (t === "pen") setOpacity(1);
    else if (t === "highlighter") setOpacity(HIGHLIGHTER_OPACITY);
  }, []);

  // 색을 고르면 최근 색 목록 맨 앞에 둔다(중복 제거).
  const setColor = useCallback((c: string) => {
    setColorState(c);
    setRecentColors((prev) => [c, ...prev.filter((x) => x !== c)].slice(0, RECENT_COLOR_LIMIT));
  }, []);

  // ---- 영속화 ----
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!dirtyRef.current || !root) return;
    const json = serializeDrawDoc(docRef.current);
    dirtyRef.current = false;
    setDirty(false);
    try {
      await ipc.writePdfDraw(root, path, json);
    } catch {
      // 저장 실패 시 다시 dirty 로 두어 다음 변경/언마운트 때 재시도
      dirtyRef.current = true;
      setDirty(true);
    }
  }, [root, path]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), AUTOSAVE_MS);
  }, [flushSave]);

  // path 변경 시 사이드카 로드. 직전 문서는 저장 후 교체.
  useEffect(() => {
    let cancelled = false;
    // 이전 path 의 미저장분을 먼저 비운다.
    void flushSave();
    docRef.current = emptyDrawDoc();
    undoRef.current = [];
    redoRef.current = [];
    setCanRedo(false);
    setShapeCount(0);
    setSelection(null);
    if (!root) return;
    ipc
      .readPdfDraw(root, path)
      .then((json) => {
        if (cancelled) return;
        docRef.current = parseDrawDoc(json);
        setShapeCount(countShapes(docRef.current));
      })
      .catch(() => {
        // 사이드카 없음(=주석 없는 PDF)은 정상.
        if (!cancelled) {
          docRef.current = emptyDrawDoc();
          setShapeCount(0);
        }
      });
    return () => {
      cancelled = true;
    };
    // path/root 가 바뀔 때만 재로딩. flushSave 는 그 둘에만 의존.
  }, [root, path, flushSave]);

  // 언마운트 시 미저장분 저장(베스트 에포트).
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (dirtyRef.current && root) {
        void ipc.writePdfDraw(root, path, serializeDrawDoc(docRef.current));
      }
    };
  }, [root, path]);

  // ---- 변경 연산 ----
  // 새 사용자 변경 직전에 호출 → undo 스택에 스냅샷을 쌓고 redo 스택은 무효화한다.
  const pushUndo = useCallback((page: number) => {
    undoRef.current.push({ page, shapes: [...shapesOnPage(docRef.current, page)] });
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    if (redoRef.current.length > 0) {
      redoRef.current = [];
      setCanRedo(false);
    }
  }, []);

  const commitShape = useCallback(
    (page: number, shape: Shape) => {
      if (!isNonEmptyShape(shape)) return; // 빈 도형(점·길이 0)은 버린다
      pushUndo(page);
      const prev = docRef.current.pages[page] ?? [];
      docRef.current.pages[page] = [...prev, shape];
      setShapeCount(countShapes(docRef.current));
      scheduleSave();
    },
    [pushUndo, scheduleSave],
  );

  const eraseAt = useCallback(
    (page: number, x: number, y: number, radius: number) => {
      const prev = docRef.current.pages[page] ?? [];
      const next = eraseShapesAt(prev, x, y, radius);
      if (next.length === prev.length) return false;
      pushUndo(page);
      docRef.current.pages[page] = next;
      setShapeCount(countShapes(docRef.current));
      scheduleSave();
      return true;
    },
    [pushUndo, scheduleSave],
  );

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    // 현재 그 페이지 상태를 redo 스택에 보관한 뒤 되돌린다.
    redoRef.current.push({ page: entry.page, shapes: [...shapesOnPage(docRef.current, entry.page)] });
    setCanRedo(true);
    docRef.current.pages[entry.page] = entry.shapes;
    setShapeCount(countShapes(docRef.current));
    scheduleSave();
  }, [scheduleSave]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    // 현재 그 페이지 상태를 undo 스택에 보관한 뒤 다시 적용한다.
    undoRef.current.push({ page: entry.page, shapes: [...shapesOnPage(docRef.current, entry.page)] });
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    docRef.current.pages[entry.page] = entry.shapes;
    setShapeCount(countShapes(docRef.current));
    setCanRedo(redoRef.current.length > 0);
    scheduleSave();
  }, [scheduleSave]);

  const clearPage = useCallback(
    (page: number) => {
      if ((docRef.current.pages[page] ?? []).length === 0) return;
      pushUndo(page);
      docRef.current.pages[page] = [];
      setShapeCount(countShapes(docRef.current));
      scheduleSave();
    },
    [pushUndo, scheduleSave],
  );

  const clearAll = useCallback(() => {
    if (countShapes(docRef.current) === 0) return;
    // 페이지별로 undo 를 쌓아 한 번의 undo 로 전체 복구가 안 되는 점은 단순화.
    for (const page of Object.keys(docRef.current.pages)) {
      pushUndo(Number(page));
    }
    docRef.current.pages = {};
    setShapeCount(0);
    scheduleSave();
  }, [pushUndo, scheduleSave]);

  // ---- 선택/편집 ----
  const selectShape = useCallback((page: number, id: string) => {
    setSelection({ page, id });
  }, []);

  const clearSelection = useCallback(() => setSelection(null), []);

  const updateShape = useCallback(
    (page: number, id: string, next: Shape) => {
      const arr = docRef.current.pages[page];
      if (!arr) return;
      const idx = arr.findIndex((s) => s.id === id);
      if (idx < 0) return;
      pushUndo(page);
      const copy = [...arr];
      copy[idx] = next;
      docRef.current.pages[page] = copy;
      bumpRevision();
      scheduleSave();
    },
    [pushUndo, scheduleSave, bumpRevision],
  );

  const removeSelected = useCallback(() => {
    if (!selection) return;
    const { page, id } = selection;
    const arr = docRef.current.pages[page];
    if (arr) {
      const next = arr.filter((s) => s.id !== id);
      if (next.length !== arr.length) {
        pushUndo(page);
        docRef.current.pages[page] = next;
        setShapeCount(countShapes(docRef.current));
        bumpRevision();
        scheduleSave();
      }
    }
    setSelection(null);
  }, [selection, pushUndo, scheduleSave, bumpRevision]);

  const reorderSelected = useCallback(
    (toFront: boolean) => {
      if (!selection) return;
      const { page, id } = selection;
      const arr = docRef.current.pages[page];
      if (!arr) return;
      const idx = arr.findIndex((s) => s.id === id);
      if (idx < 0) return;
      pushUndo(page);
      const copy = [...arr];
      const [sh] = copy.splice(idx, 1);
      if (toFront) copy.push(sh);
      else copy.unshift(sh);
      docRef.current.pages[page] = copy;
      bumpRevision();
      scheduleSave();
    },
    [selection, pushUndo, scheduleSave, bumpRevision],
  );

  const bringSelectedToFront = useCallback(() => reorderSelected(true), [reorderSelected]);
  const sendSelectedToBack = useCallback(() => reorderSelected(false), [reorderSelected]);

  const duplicateSelected = useCallback(() => {
    if (!selection) return;
    const { page, id } = selection;
    const arr = docRef.current.pages[page];
    const sh = arr?.find((s) => s.id === id);
    if (!arr || !sh) return;
    const copy: Shape = { ...translateShape(sh, 10, 10), id: newShapeId() };
    pushUndo(page);
    docRef.current.pages[page] = [...arr, copy];
    setShapeCount(countShapes(docRef.current));
    bumpRevision();
    scheduleSave();
    setSelection({ page, id: copy.id });
  }, [selection, pushUndo, scheduleSave, bumpRevision]);

  const effectiveWidth = useCallback(() => {
    return tool === "highlighter" ? width * 4 : width;
  }, [tool, width]);

  const getDoc = useCallback(() => docRef.current, []);

  return {
    tool,
    setTool,
    color,
    setColor,
    width,
    setWidth,
    opacity,
    setOpacity,
    fill,
    setFill,
    recentColors,
    revision,
    selection,
    selectShape,
    clearSelection,
    updateShape,
    removeSelected,
    duplicateSelected,
    bringSelectedToFront,
    sendSelectedToBack,
    effectiveWidth,
    docRef,
    isDrawing: tool !== "move" && tool !== "select",
    shapeCount,
    dirty,
    commitShape,
    eraseAt,
    undo,
    redo,
    canRedo,
    clearPage,
    clearAll,
    getDoc,
  };
}
