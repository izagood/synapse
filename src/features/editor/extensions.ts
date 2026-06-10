import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import type { AnyExtension, Editor } from "@tiptap/core";

// 에디터 본체와 라운드트립 테스트가 동일한 구성을 쓰도록 한 곳에 모은다.
// withPlaceholder=false: Placeholder는 브라우저 전용 API(elementFromPoint)를 써서
// 헤드리스(jsdom) 라운드트립 테스트에서는 제외한다 — md 변환에는 관여하지 않는다.
export function editorExtensions({ withPlaceholder = true } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      link: { openOnClick: false },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    ...(withPlaceholder
      ? [Placeholder.configure({ placeholder: "내용을 입력하세요. '# ', '- ', '> ' 같은 마크다운 단축 입력을 지원합니다." })]
      : []),
    Markdown.configure({
      html: true, // 표현 불가능한 원시 HTML은 보존 (NFR-3)
      tightLists: true,
      linkify: false,
      breaks: false,
      transformPastedText: true,
    }),
  ];
}

export function getMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as {
    markdown: { getMarkdown(): string };
  };
  return storage.markdown.getMarkdown();
}
