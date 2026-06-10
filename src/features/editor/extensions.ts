import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import type { AnyExtension, Editor } from "@tiptap/core";
import { resolveAssetUrl } from "../../ipc/ipc";

// 현재 편집 중인 노트의 디렉토리 — 상대 경로 이미지를 화면에 표시할 때만 사용.
// 문서 모델(attrs.src)에는 항상 상대 경로가 남아 md 직렬화가 오염되지 않는다.
let imageBaseDir = "";
export function setImageBaseDir(dir: string) {
  imageBaseDir = dir;
}

function displayImageSrc(src: string): string {
  if (/^(https?:|data:|asset:|blob:)/i.test(src) || !imageBaseDir) return src;
  return resolveAssetUrl(`${imageBaseDir}/${src.replace(/^\.\//, "")}`);
}

const WorkspaceImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      { ...HTMLAttributes, src: displayImageSrc(String(HTMLAttributes.src ?? "")) },
    ];
  },
});

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
    // 표 보존 (FR-2.1) — 없으면 md 표가 텍스트로 뭉개진다
    TableKit.configure({ table: { resizable: false } }),
    WorkspaceImage,
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
  return tightenTaskLists(storage.markdown.getMarkdown());
}

/**
 * 직렬화가 체크리스트 항목 사이에 끼워 넣는 빈 줄을 제거한다.
 * (tight 목록이 loose로 바뀌는 라운드트립 손상 방지)
 */
export function tightenTaskLists(markdown: string): string {
  let prev;
  do {
    prev = markdown;
    markdown = markdown.replace(
      /^([ \t]*- \[[ xX]\] .*)\n\n(?=[ \t]*- \[[ xX]\] )/gm,
      "$1\n",
    );
  } while (markdown !== prev);
  return markdown;
}
