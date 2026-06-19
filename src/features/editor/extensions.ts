import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";
import type { AnyExtension, Editor } from "@tiptap/core";
import { resolveAssetUrl } from "../../ipc/ipc";
import { ko } from "../../i18n/locales/ko";
import { SearchHighlight } from "./search";
import { LineNumberGutter } from "./lineNumberGutter";
import { MermaidCodeBlock } from "./mermaidBlock";
import { LinkifyUrls } from "./linkifyUrls";

// 현재 편집 중인 노트의 디렉토리 — 상대 경로 이미지를 화면에 표시할 때만 사용.
// 문서 모델(attrs.src)에는 항상 상대 경로가 남아 md 직렬화가 오염되지 않는다.
let imageBaseDir = "";
export function setImageBaseDir(dir: string) {
  imageBaseDir = dir;
}

function displayImageSrc(src: string): string {
  if (/^(https?:|data:|asset:|blob:)/i.test(src) || !imageBaseDir) return src;
  // 원격(ssh://) 워크스페이스의 상대 경로 이미지는 asset protocol로 직접 못 읽는다
  // (SFTP). 깨진 asset URL을 만드는 대신 상대 경로를 그대로 둬 깔끔히 degrade한다.
  // 원격 이미지 인라인 렌더링(SFTP→로컬 캐시)은 후속 작업이다.
  if (imageBaseDir.startsWith("ssh://")) return src;
  let rel = src.replace(/^\.\//, "");
  // markdown-it이 파싱 시 목적지를 %인코딩하므로(한글 파일명 등),
  // 디스크의 실제 파일명으로 되돌려 asset URL을 만든다.
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // %가 인코딩이 아닌 파일명 — 그대로 사용
  }
  return resolveAssetUrl(`${imageBaseDir}/${rel}`);
}

// 코드 블록 문법 하이라이팅 — lowlight common 세트(37개 언어: rust, ts, python 등).
// 노드 이름(codeBlock)과 language 속성은 기본 CodeBlock과 동일해 md 직렬화에 영향 없음.
export const lowlight = createLowlight(common);

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
export function editorExtensions({
  withPlaceholder = true,
  placeholder = ko.editor.placeholder,
  mermaidErrorLabel = ko.editor.mermaidError,
}: {
  withPlaceholder?: boolean;
  placeholder?: string;
  mermaidErrorLabel?: string;
} = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        // 스킴 없는 상대경로 링크(advanced/01.md 등)는 그대로 허용한다.
        // tiptap 기본 isAllowedUri의 정규식 [^a-z+.-:]에서 .-: 가 범위(./0-9:)로
        // 해석돼 '/'를 포함하는 바람에, 첫 글자가 영문이고 중간에 '/'가 있으며
        // './'로 시작하지 않는 상대경로가 파싱 시점에 링크 마크째로 버려진다.
        // (md 라운드트립에서 [텍스트](advanced/x.md)가 평문으로 뭉개지는 원인)
        // 스킴이 있으면(https:, javascript: 등) 기본 검증을 그대로 적용해
        // 위험 스킴은 계속 차단한다.
        isAllowedUri: (url, ctx) =>
          /^[a-z][a-z0-9+.-]*:/i.test(url) ? ctx.defaultValidate(url) : true,
      },
      codeBlock: false, // CodeBlockLowlight로 대체
    }),
    // CodeBlockLowlight 확장: ```mermaid 블록은 다이어그램으로 렌더링,
    // 그 외 코드 블록은 종전대로 lowlight 하이라이팅
    MermaidCodeBlock({ lowlight, errorLabel: mermaidErrorLabel }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 표 보존 (FR-2.1) — 없으면 md 표가 텍스트로 뭉개진다
    TableKit.configure({ table: { resizable: false } }),
    WorkspaceImage,
    // 문서 내 찾기 하이라이트 (Cmd/Ctrl+F) — md 직렬화에 관여하지 않음
    SearchHighlight,
    // WYSIWYG 줄 번호 거터 — 데코레이션만 항상 달고, 표시 여부는 CSS로 토글
    LineNumberGutter,
    // 본문 속 맨 URL을 클릭 가능한 링크로 표시 — 문서 모델/직렬화에 관여하지 않음
    LinkifyUrls,
    ...(withPlaceholder
      ? [Placeholder.configure({ placeholder })]
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
