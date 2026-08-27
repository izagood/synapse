import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { editorExtensions, getMarkdown, setImageBaseDir } from "./extensions";
import { detectLegacyFrontmatter, joinFrontmatter, splitFrontmatter } from "./frontmatter";
import { resolveInternalLink } from "./internalLink";
import { resolveWikiTarget } from "./wikiLinkNavigation";
import { insertImages, isImageFile } from "./images";
import { FindBar } from "./FindBar";
import { useT } from "../../i18n";
import { hasRoundtripContentLoss } from "./roundtripSafety";
import { preserveFormatting } from "./preserveFormatting";
import { deferUntilCompositionEnd } from "./deferUntilCompositionEnd";

// 활성 마크다운 문서의 WYSIWYG 에디터.
// 탭 전환/모드 전환 시 key로 리마운트되어 항상 store의 content에서 출발한다.
//
// 라운드트립 안전장치 (NFR-3):
// 1. 사용자가 실제로 편집하기 전에는 절대 파일을 다시 쓰지 않는다 —
//    undo로 원래 상태로 돌아오면 디스크의 원본 텍스트가 그대로 유지된다.
// 2. 에디터 변환이 원본 내용을 보존하지 못하면(미지원 HTML 등) 위지윅 편집을
//    **읽기 전용으로 잠그고** 소스 모드로 유도한다.
//
//    경고만 띄우고 편집을 허용하면 손실된 직렬화 결과가 그대로 디스크에 쓰인다.
//    저장은 사용자가 저장을 눌러야 일어나는 일이 아니다 —
//    updateContent 가 자동저장 타이머를 걸고(workspace.ts), sync 도
//    syncNow → flushDirty 로 모든 dirty 문서를 강제 저장한다(sync.ts).
//    그래서 차단은 updateContent 로 들어가기 **전에** 걸려야 한다.
//    편집 자체를 막는 것이 가장 확실한 지점이다.
//
//    소스 모드(SourceEditor)는 직렬화기를 거치지 않는 원문 textarea 이므로
//    이 문서도 계속 편집할 수 있다 — 편집 수단을 뺏는 것이 아니라 옮기는 것이다.
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
  // frontmatter는 화면에 노출하지 않고 원문 그대로 보존만 한다(저장 시 본문과 재결합).
  // 편집은 소스 모드에서 한다.
  const fmRef = useRef(initial.frontmatter);
  const keepNlRef = useRef(/\n$/.test(initial.body));

  // 편집 전 기준 직렬화 결과 — 여기서 변하지 않는 한 "편집 없음"으로 취급
  const baseline = useRef<string | null>(null);
  // 외부 머지 적용 중에는 onUpdate를 무시한다(사용자 편집으로 오인한 저장 루프 방지).
  const applyingExternal = useRef(false);
  // 외부 리로드 카운터와 "에디터에 적용된" 카운터. onUpdate가 참조하므로 반드시
  // useEditor 호출보다 위에 있어야 한다 — Placeholder의 viewport 플러그인이 뷰
  // 생성 "도중" 트랜잭션을 dispatch해, 문서 끝이 문단이 아니면(TrailingNode가
  // 빈 문단을 append) onUpdate가 이 컴포넌트 함수 실행 중간에 동기 발화한다.
  // 아래 선언이면 TDZ ReferenceError로 React 트리 전체가 unmount된다(빈 화면).
  const externalRev = useWorkspace((s) => s.docs[path]?.externalRev ?? 0);
  const appliedRev = useRef(externalRev);
  // 변환 손실이 감지되면 위지윅 편집을 잠근다(읽기 전용). 배너는 닫을 수 없다 —
  // 무시하고 편집을 이어가면 손실본이 저장되므로, 알림이 아니라 상태 표시다.
  const [lossy, setLossy] = useState(false);
  const [legacyFrontmatter, setLegacyFrontmatter] = useState(false);
  const toggleSourceMode = useWorkspace((s) => s.toggleSourceMode);

  // 상대 경로 이미지 표시용 기준 디렉토리 (직렬화에는 영향 없음)
  setImageBaseDir(path.slice(0, path.lastIndexOf("/")));

  // 마운트 시점의 store 값으로 자동 포커스 여부를 한 번만 결정한다.
  // 사이드바에서 파일을 "선택"만 했을 때는 false → 포커스가 트리 행에 남아
  // Enter로 인라인 이름 변경에 진입할 수 있다(파일 열기로 줄바꿈이 새지 않음).
  const autofocusOnMount = useRef(useWorkspace.getState().autoFocusEditor).current;

  const editor = useEditor({
    extensions: editorExtensions({ placeholder, mermaidErrorLabel }),
    content: initial.body,
    autofocus: autofocusOnMount,
    onCreate({ editor }) {
      baseline.current = getMarkdown(editor);
      // 로드 직후 직렬화 결과에서 이미 내용이 사라졌다면 변환 손실로 판정한다.
      // 배너만 띄우고 편집을 허용하면 손실본이 자동저장·sync 로 디스크에 박히므로
      // 위지윅 편집을 잠근다(아래 effect 가 editable 을 반영).
      setLossy(hasRoundtripContentLoss(initial.body, baseline.current));
      // 구 규칙 frontmatter(`---` 다음 빈 줄) 문서는 위지윅 편집 시 YAML이
      // setext 헤딩으로 변질될 수 있다 — 감지해서 소스 모드로 유도한다.
      setLegacyFrontmatter(detectLegacyFrontmatter(original.current).detected);
    },
    editorProps: {
      // 링크 클릭: 외부 링크는 시스템 브라우저로, vault 내 상대 경로/link는
      // 해당 노트를 탭으로 열며, 위키링크는 stem 매칭으로 탐색한다 (커서는 CSS에서 pointer)
      handleClick(_view, _pos, event) {
        const targetEl = event.target as HTMLElement;
        const wikiLink = targetEl.closest?.("[data-wikilink]");
        if (wikiLink) {
          const inner = wikiLink.getAttribute("data-inner");
          const ws = useWorkspace.getState();
          const hit = inner && ws.tree ? resolveWikiTarget(inner, ws.tree) : null;
          if (hit && !hit.ambiguous) {
            void ws.openFileAt(hit.path);
            return true;
          }
          // 대상이 없거나 stem이 모호하면 이동하지 않는다. 여기서 true를
          // 돌려주면 노드 선택·커서 이동 같은 기본 동작까지 막히므로 false.
          return false;
        }
        const anchor = targetEl.closest?.("a");
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
      if (applyingExternal.current) return;
      const currentExternalRev = useWorkspace.getState().docs[path]?.externalRev ?? 0;
      if (appliedRev.current !== currentExternalRev) {
        // 외부 변경이 아직 에디터에 적용되지 않은 창에서 사용자가 입력했다.
        // 이전에는 이 입력을 통째로 무시했고(F5), 뒤이은 setContent가 그
        // 타이핑을 지웠다. 이제는 외부 적용을 포기하고(rev를 소비) 배지로
        // 강등한 뒤 사용자 입력을 정상 반영한다.
        //
        // 이때 반드시 savedContent를 original.current(= 에디터가 실제로 보고
        // 있는, 리로드 이전 전문)로 되돌려야 한다. reloadAfterSync가 이미
        // savedContent를 새 디스크 내용으로 전진시켰기 때문에, 되돌리지 않으면
        // 저장 시 base == disk가 되어 백엔드 3-way가 실행되지 않고 외부 변경이
        // 조용히 덮어써진다. 되돌려야 다음 저장에서 병합이 실제로 돌아간다.
        appliedRev.current = currentExternalRev;
        useWorkspace.getState().demoteExternalToStale(path, original.current);
      }
      let markdown = getMarkdown(editor);
      if (markdown === baseline.current) {
        // 편집했다가 원래대로 돌아온 경우: 원본 텍스트를 그대로 복원해
        // 정규화된 내용이 디스크에 쓰이지 않게 한다
        updateContent(path, original.current);
        return;
      }
      // 편집한 블록만 재직렬화하고, 손대지 않은 블록은 원본 바이트를 되살린다.
      // baseline(=원본 본문의 재직렬화본)을 "편집 안 됨"의 기준으로 삼는다.
      if (baseline.current !== null) {
        const originalBody = splitFrontmatter(original.current).body;
        markdown = preserveFormatting(originalBody, baseline.current, markdown);
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

  // 변환 손실이 감지된 문서는 위지윅 편집을 잠근다.
  // onUpdate 자체가 발생하지 않으므로 updateContent → 자동저장 → sync 강제 저장
  // 경로가 통째로 차단된다. 읽기·복사·검색은 그대로 되고, 편집은 소스 모드에서 한다.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!lossy);
  }, [editor, lossy]);

  // 외부 리로드 반영: store의 content가 에디터 밖에서 바뀌면(저장 결과 반영,
  // sync 후 깨끗한 문서 리로드 등) 새 내용을 전체 교체로 적용하고 커서를
  // (범위 안으로) 복원한다. 라이브 머지는 없다 — 편집 중인 문서는 sync가
  // 건드리지 않고 externalStale 배지로만 알린다(워크스페이스 store 참고).
  useEffect(() => {
    if (!editor || editor.isDestroyed || externalRev === appliedRev.current) return;

    // 외부 리로드를 화면에 반영한다. 적용 시점에 store의 최신 내용/rev를 다시 읽어,
    // 조합 종료까지 연기된 사이 추가로 들어온 변경까지 한 번에 coalesce해 반영한다.
    const applyExternal = () => {
      if (!editor || editor.isDestroyed) return;
      const liveDoc = useWorkspace.getState().docs[path];
      appliedRev.current = liveDoc?.externalRev ?? externalRev;
      const text = liveDoc?.content ?? "";
      if (text === original.current) return;
      const split = splitFrontmatter(text);
      // 전체 교체(setContent)로 반영한다. 적용은 emitUpdate:false라 onUpdate를
      // 발화시키지 않으므로 쓰기-되먹임 걱정이 없다 — applyingExternal 가드는
      // 그래도 방어적으로 유지한다.
      applyingExternal.current = true;
      try {
        const { from, to } = editor.state.selection;
        editor.commands.setContent(split.body, { emitUpdate: false });
        const max = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
      } finally {
        applyingExternal.current = false;
      }
      original.current = text;
      fmRef.current = split.frontmatter;
      keepNlRef.current = /\n$/.test(split.body);
      baseline.current = getMarkdown(editor);
      // 외부 리로드로 내용이 바뀌었으니 손실 여부를 다시 판정한다.
      // (손실이 해소되면 위지윅 편집이 자동으로 다시 열린다)
      setLossy(hasRoundtripContentLoss(split.body, baseline.current));
    };

    // 한글 IME 조합 도중 setContent가 발화하면 문서가 붕괴하므로
    // 조합 종료(compositionend)까지 연기한다. 조합 중이 아니면 즉시 반영.
    // 한글 연타(음절마다 compositionend→compositionstart)의 경우 적용 직전에
    // 재확인해 새 조합이 시작됐으면 다음 조합 종료까지 다시 연기한다.
    return deferUntilCompositionEnd(
      editor.view.dom,
      editor.view.composing,
      applyExternal,
      () => editor.view.composing,
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
      {lossy && (
        <div className="lossy-banner">
          <span>⚠️ {t("editor.lossyReadonly")}</span>
          <button className="lossy-banner-action" onClick={toggleSourceMode}>
            {t("editor.openSourceMode")}
          </button>
        </div>
      )}
      {legacyFrontmatter && (
        // 구 규칙 frontmatter 안내. 위지윅에서 자동 정규화하지 않는다 —
        // store만 바꾸면 에디터 내용과 어긋나고, 다음 onUpdate가 에디터
        // 기준으로 store를 되덮어 정규화가 사라진다. 소스 모드는 원문
        // textarea라 사용자가 빈 줄 하나만 지우면 끝난다.
        <div className="lossy-banner">
          <span>⚠️ {t("editor.legacyFrontmatterWarning")}</span>
          <button className="lossy-banner-action" onClick={toggleSourceMode}>
            {t("editor.openSourceMode")}
          </button>
          <button
            className="lossy-banner-action"
            onClick={() => setLegacyFrontmatter(false)}
          >
            {t("editor.dismissWarning")}
          </button>
        </div>
      )}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

// 소스(raw markdown) 모드: 파일 전체 텍스트를 frontmatter 포함 그대로 편집.
export function SourceEditor({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const updateContent = useWorkspace((s) => s.updateContent);
  const content = doc?.content ?? "";
  return (
    <textarea
      className="source-editor"
      value={content}
      onChange={(e) => updateContent(path, e.target.value)}
      spellCheck={false}
    />
  );
}
