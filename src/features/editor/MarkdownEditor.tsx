import { useMemo } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { editorExtensions, getMarkdown } from "./extensions";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";

// 활성 마크다운 문서의 WYSIWYG 에디터.
// 탭 전환/모드 전환 시 key로 리마운트되어 항상 store의 content에서 출발한다.
export function MarkdownEditor({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const updateContent = useWorkspace((s) => s.updateContent);

  // 마운트 시점의 frontmatter를 고정 보존하고 에디터에는 본문만 넣는다 (FR-2.9 1단계)
  const initial = useMemo(() => splitFrontmatter(doc?.content ?? ""), [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    extensions: editorExtensions(),
    content: initial.body,
    autofocus: true,
    editorProps: {
      // 링크 클릭 시 시스템 브라우저로 연다 (커서는 CSS에서 pointer)
      handleClick(_view, _pos, event) {
        const anchor = (event.target as HTMLElement).closest?.("a");
        const href = anchor?.getAttribute("href");
        if (href && /^https?:\/\//i.test(href)) {
          void ipc.openExternal(href);
          return true;
        }
        return false;
      },
    },
    onUpdate({ editor }) {
      updateContent(path, joinFrontmatter(initial.frontmatter, getMarkdown(editor)));
    },
  });

  return (
    <div className="editor-wrap">
      {initial.frontmatter && (
        <div className="frontmatter-badge" title={initial.frontmatter}>
          frontmatter 보존됨 — 소스 모드에서 편집 가능
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
