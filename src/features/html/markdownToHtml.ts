// 노트(마크다운)를 보기 좋은 standalone HTML로 내보낸다 (FR-3.5).
//
// "AI 시대의 뷰어"와 일관: 노트를 어디서나 열리는 자기완결적 HTML 문서로
// 만들어 저장/클립보드로 내보낸다. 본문 변환은 에디터와 같은 tiptap 구성을
// 거치므로 표/코드/링크/체크리스트가 화면에서 보던 그대로 직렬화된다.

import { Editor } from "@tiptap/core";
import { editorExtensions } from "../editor/extensions";
import { splitFrontmatter } from "../editor/frontmatter";

export interface ExportOptions {
  /** <title> 및 문서 제목 — 보통 파일명(확장자 제외) */
  title?: string;
}

/**
 * 노트 경로(.md)에 대응하는 내보내기용 HTML 경로(.html)를 만든다.
 * 확장자만 교체하며, 확장자가 없으면 .html을 덧붙인다.
 */
export function htmlExportPath(notePath: string): string {
  return notePath.replace(/\.(md|markdown)$/i, "") + ".html";
}

/** 파일 경로에서 확장자를 뗀 표시용 제목을 뽑는다. */
export function titleFromPath(notePath: string): string {
  const base = notePath.split(/[/\\]/).pop() ?? notePath;
  return base.replace(/\.(md|markdown|html?|)$/i, "") || base;
}

// 내보낸 문서가 그 자체로 읽기 좋도록 하는 최소 스타일.
// 뷰어(buildViewerHtml)의 본문 스타일과 톤을 맞춘다.
const EXPORT_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 2.5rem auto; max-width: 48rem; padding: 0 1.5rem;
         font-family: -apple-system, "Pretendard", "Noto Sans KR", system-ui, sans-serif;
         line-height: 1.7; color: #1a1a1a; background: #fff; }
  h1, h2, h3, h4 { line-height: 1.3; margin-top: 1.6em; }
  h1 { font-size: 1.9rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.25rem; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  :not(pre) > code { background: #f0f0f0; padding: 0.15em 0.35em; border-radius: 4px; }
  blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ddd; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.75em; text-align: left; }
  th { background: #f7f7f7; }
  ul[data-type="taskList"] { list-style: none; padding-left: 0.5em; }
  ul[data-type="taskList"] li { display: flex; gap: 0.5em; align-items: baseline; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e3e3e3; background: #1a1a1a; }
    a { color: #6ea8fe; }
    pre, :not(pre) > code { background: #2a2a2a; }
    blockquote { border-left-color: #444; color: #aaa; }
    th, td { border-color: #3a3a3a; } th { background: #242424; }
    hr { border-top-color: #3a3a3a; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 마크다운 본문을 tiptap이 렌더하는 것과 동일한 HTML 본문 조각으로 변환한다.
 * frontmatter(--- 블록)는 메타데이터이므로 본문에서 제외한다.
 */
export function markdownToHtmlBody(markdown: string): string {
  const { body } = splitFrontmatter(markdown);
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: body,
  });
  try {
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

/**
 * 노트를 자기완결적(standalone) HTML 문서로 내보낸다 (FR-3.5).
 *
 * - frontmatter 제외한 본문을 에디터와 동일하게 렌더
 * - 읽기 좋은 기본 스타일 + 다크모드 대응을 인라인 <style>로 포함
 * - 외부 의존성/스크립트 없음 — 파일을 그대로 열거나 붙여넣어도 안전
 */
export function markdownToStandaloneHtml(
  markdown: string,
  options: ExportOptions = {},
): string {
  const title = options.title?.trim() || "Untitled";
  const bodyHtml = markdownToHtmlBody(markdown);
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${EXPORT_STYLE}</style>`,
    "</head>",
    "<body>",
    bodyHtml,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
