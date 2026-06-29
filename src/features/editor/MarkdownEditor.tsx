import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { editorExtensions, getMarkdown, setImageBaseDir } from "./extensions";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";
import { resolveInternalLink } from "./internalLink";
import { insertImages, isImageFile } from "./images";
import { FrontmatterPanel } from "./FrontmatterPanel";
import { FindBar } from "./FindBar";
import { useT } from "../../i18n";
import { hasRoundtripContentLoss } from "./roundtripSafety";
import { deferUntilCompositionEnd } from "./deferUntilCompositionEnd";

// 활성 마크다운 문서의 WYSIWYG 에디터.
// 탭 전환/모드 전환 시 key로 리마운트되어 항상 store의 content에서 출발한다.
//
// 라운드트립 안전장치 (NFR-3):
// 1. 사용자가 실제로 편집하기 전에는 절대 파일을 다시 쓰지 않는다 —
//    undo로 원래 상태로 돌아오면 디스크의 원본 텍스트가 그대로 유지된다.
// 2. 에디터 변환이 원본 내용을 보존하지 못하면(미지원 HTML 등) 경고 배너를 띄운다.
export function MarkdownEditor({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const updateContent = useWorkspace((s) => s.updateContent);
  const t = useT();
  const placeholder = t("editor.placeholder");
  const mermaidErrorLabel = t("editor.mermaidError");

  // 마운트 시점의 원본 전문과 frontmatter를 보존 (FR-2.9 1단계).
  // 원격 머지가 반영되면(externalRev) 아래 effect가 이 기준들을 갱신한다.
  const original = useRef(doc?.content ?? "");
  const initial = useMemo(() => splitFrontmatter(original.current), [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [frontmatter, setFrontmatter] = useState(initial.frontmatter);
  const fmRef = useRef(initial.frontmatter);
  const keepNlRef = useRef(/\n$/.test(initial.body));

  // 편집 전 기준 직렬화 결과 — 여기서 변하지 않는 한 "편집 없음"으로 취급
  const baseline = useRef<string | null>(null);
  const [lossy, setLossy] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState(false);

  // 상대 경로 이미지 표시용 기준 디렉토리 (직렬화에는 영향 없음)
  setImageBaseDir(path.slice(0, path.lastIndexOf("/")));

  const editor = useEditor({
    extensions: editorExtensions({ placeholder, mermaidErrorLabel }),
    content: initial.body,
    autofocus: true,
    onCreate({ editor }) {
      baseline.current = getMarkdown(editor);
      // 로드 직후 직렬화 결과에서 이미 내용이 사라졌다면 변환 손실 경고
      setLossy(hasRoundtripContentLoss(initial.body, baseline.current));
    },
    editorProps: {
      // 링크 클릭: 외부 링크는 시스템 브라우저로, vault 내 상대 경로 링크는
      // 해당 노트를 탭으로 연다 (커서는 CSS에서 pointer)
      handleClick(_view, _pos, event) {
        const anchor = (event.target as HTMLElement).closest?.("a");
        const href = anchor?.getAttribute("href");
        if (!href) return false;
        if (/^https?:\/\//i.test(href)) {
          void ipc.openExternal(href);
          return true;
        }
        const ws = useWorkspace.getState();
        const target = ws.root ? resolveInternalLink(href, path, ws.root) : null;
        if (target) {
          void ws.openFileAt(target);
          return true;
        }
        return false;
      },
      // 이미지 파일 드래그앤드롭: 떨어뜨린 위치에 삽입, 원본 파일명으로 같은 폴더에 저장
      handleDrop(view, event, _slice, moved) {
        if (moved) return false; // 에디터 내부 이동은 기본 동작
        const images = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
        if (images.length === 0) return false;
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const editor = editorRef.current;
        if (editor) void insertImages(editor, images, path, coords?.pos);
        return true;
      },
      // 클립보드 이미지 붙여넣기: 랜덤 파일명으로 저장 후 커서 위치에 삽입
      handlePaste(_view, event) {
        const items = Array.from(event.clipboardData?.items ?? []);
        const images = items
          .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
          .map((i) => i.getAsFile())
          .filter((f): f is File => f !== null);
        if (images.length === 0) return false;
        event.preventDefault();
        const editor = editorRef.current;
        if (editor) void insertImages(editor, images, path);
        return true;
      },
    },
    onUpdate({ editor }) {
      let markdown = getMarkdown(editor);
      if (markdown === baseline.current) {
        // 편집했다가 원래대로 돌아온 경우: 원본 텍스트를 그대로 복원해
        // 정규화된 내용이 디스크에 쓰이지 않게 한다
        updateContent(path, original.current);
        return;
      }
      if (keepNlRef.current && !markdown.endsWith("\n")) markdown += "\n";
      updateContent(path, joinFrontmatter(fmRef.current, markdown));
    },
  }, [path, placeholder, mermaidErrorLabel]);

  const editorRef = useRef(editor);
  editorRef.current = editor;

  // 문서 내 찾기 (Cmd/Ctrl+F) — 이미 열려 있으면 입력에 다시 포커스한다.
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
        setFindFocus((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 속성 패널에서 frontmatter가 바뀌면: 새 frontmatter를 기준값으로 삼고,
  // 현재 본문과 합쳐 기존 저장 경로로 기록한다 (파일 직접 쓰기 없음).
  function handleFrontmatterChange(next: string) {
    fmRef.current = next;
    setFrontmatter(next);
    const ed = editorRef.current;
    const md = ed ? getMarkdown(ed) : null;
    // 본문을 아직 편집하지 않았다면(에디터가 baseline 그대로) 원문 본문을
    // 그대로 보존해 정규화로 인한 변형을 피한다.
    let body: string;
    if (md === null || md === baseline.current) {
      body = splitFrontmatter(original.current).body;
    } else {
      body = md;
      if (keepNlRef.current && !body.endsWith("\n")) body += "\n";
    }
    updateContent(path, joinFrontmatter(next, body));
  }

  // 원격 머지/외부 편집 반영 (FR-6 라이브 머지): store의 content가 에디터 밖에서
  // 바뀌면 새 내용을 적용하고 커서를 (범위 안으로) 복원한다. 저장 직후 돌아온
  // 합쳐진 텍스트(synapse_id 주입 포함)도 같은 경로로 반영된다.
  const externalRev = useWorkspace((s) => s.docs[path]?.externalRev ?? 0);
  const appliedRev = useRef(externalRev);
  useEffect(() => {
    if (!editor || editor.isDestroyed || externalRev === appliedRev.current) return;

    // 외부 머지를 화면에 반영한다. 적용 시점에 store의 최신 내용/rev를 다시 읽어,
    // 조합 종료까지 연기된 사이 추가로 들어온 변경까지 한 번에 coalesce해 반영한다.
    const applyExternal = () => {
      if (!editor || editor.isDestroyed) return;
      const liveDoc = useWorkspace.getState().docs[path];
      appliedRev.current = liveDoc?.externalRev ?? externalRev;
      const text = liveDoc?.content ?? "";
      if (text === original.current) return;
      const split = splitFrontmatter(text);
      const { from, to } = editor.state.selection;
      // 불변식: setContent은 undo 가능해야 한다(붕괴 시 마지막 복구 수단).
      // addToHistory:false를 넣지 않는다.
      editor.commands.setContent(split.body, { emitUpdate: false });
      const max = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
      original.current = text;
      fmRef.current = split.frontmatter;
      keepNlRef.current = /\n$/.test(split.body);
      setFrontmatter(split.frontmatter);
      baseline.current = getMarkdown(editor);
      setLossy(hasRoundtripContentLoss(split.body, baseline.current));
      setDismissedWarning(false);
    };

    // 한글 IME 조합 도중 setContent가 발화하면 문서가 붕괴하므로
    // 조합 종료(compositionend)까지 연기한다. 조합 중이 아니면 즉시 반영.
    return deferUntilCompositionEnd(
      editor.view.dom,
      editor.view.composing,
      applyExternal,
    );
  }, [editor, externalRev, path]);

  return (
    <div className="editor-wrap">
      {findOpen && editor && (
        <FindBar
          editor={editor}
          focusSignal={findFocus}
          onClose={() => {
            setFindOpen(false);
            editor.commands.focus();
          }}
        />
      )}
      {frontmatter && (
        <FrontmatterPanel
          // 외부 머지(synapse_id 주입 등)로 frontmatter가 통째로 바뀌면
          // 편집 버퍼를 새 원문 기준으로 리셋하기 위해 externalRev로 리마운트한다.
          key={`fm:${externalRev}`}
          frontmatter={frontmatter}
          onChange={handleFrontmatterChange}
        />
      )}
      {lossy && !dismissedWarning && (
        <div className="lossy-banner">
          <span>⚠️ {t("editor.lossyWarning")}</span>
          <button onClick={() => setDismissedWarning(true)} title={t("editor.dismissWarning")}>
            ×
          </button>
        </div>
      )}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

// 소스(raw markdown) 모드: 파일 전체 텍스트를 frontmatter 포함 그대로 편집
export function SourceEditor({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const updateContent = useWorkspace((s) => s.updateContent);

  return (
    <textarea
      className="source-editor"
      value={doc?.content ?? ""}
      onChange={(e) => updateContent(path, e.target.value)}
      spellCheck={false}
    />
  );
}
