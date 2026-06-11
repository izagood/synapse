import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { editorExtensions, getMarkdown, setImageBaseDir } from "./extensions";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";
import { resolveInternalLink } from "./internalLink";
import { insertImages, isImageFile } from "./images";

/** 의미 비교용: 공백·이스케이프 차이를 무시하고 내용만 비교 */
function essence(markdown: string): string {
  return markdown.replace(/[\s\\]+/g, "");
}

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
    extensions: editorExtensions(),
    content: initial.body,
    autofocus: true,
    onCreate({ editor }) {
      baseline.current = getMarkdown(editor);
      // 로드 직후 직렬화 결과에서 이미 내용이 사라졌다면 변환 손실 경고
      setLossy(essence(baseline.current) !== essence(initial.body));
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
  });

  const editorRef = useRef(editor);
  editorRef.current = editor;

  // 원격 머지/외부 편집 반영 (FR-6 라이브 머지): store의 content가 에디터 밖에서
  // 바뀌면 새 내용을 적용하고 커서를 (범위 안으로) 복원한다. 저장 직후 돌아온
  // 합쳐진 텍스트(synapse_id 주입 포함)도 같은 경로로 반영된다.
  const externalRev = useWorkspace((s) => s.docs[path]?.externalRev ?? 0);
  const appliedRev = useRef(externalRev);
  useEffect(() => {
    if (!editor || editor.isDestroyed || externalRev === appliedRev.current) return;
    appliedRev.current = externalRev;
    const text = useWorkspace.getState().docs[path]?.content ?? "";
    if (text === original.current) return;
    const split = splitFrontmatter(text);
    const { from, to } = editor.state.selection;
    editor.commands.setContent(split.body, { emitUpdate: false });
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    original.current = text;
    fmRef.current = split.frontmatter;
    keepNlRef.current = /\n$/.test(split.body);
    setFrontmatter(split.frontmatter);
    baseline.current = getMarkdown(editor);
  }, [editor, externalRev, path]);

  return (
    <div className="editor-wrap">
      {frontmatter && (
        <div className="frontmatter-badge" title={frontmatter}>
          frontmatter 보존됨 — 소스 모드에서 편집 가능
        </div>
      )}
      {lossy && !dismissedWarning && (
        <div className="lossy-banner">
          <span>
            ⚠️ 이 문서에는 에디터가 완전히 보존하지 못하는 요소(HTML 등)가
            있습니다. 편집하면 해당 부분이 손실될 수 있으니 소스 모드 사용을
            권장합니다. (편집하지 않으면 파일은 변경되지 않습니다)
          </span>
          <button onClick={() => setDismissedWarning(true)} title="닫기">
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
