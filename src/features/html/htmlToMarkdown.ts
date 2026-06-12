// AI가 만든 HTML을 편집 가능한 노트(마크다운)로 가져온다 (FR-3.4).
//
// "AI 시대의 뷰어" 정체성의 반대 방향: 보기만 하던 HTML을 노트로 끌어와
// 직접 편집할 수 있게 만든다. 신뢰할 수 없는 입력이므로 변환 전에 정화한다(NFR-4).
//
// 파이프라인: 원시 HTML → DOMPurify 정화 → tiptap 파싱 → 마크다운 직렬화.
// tiptap/markdown-it 스택을 그대로 재사용해 에디터가 실제로 다루는 것과
// 동일한 의미 모델을 거치므로, 가져온 노트는 곧바로 라운드트립 안전하다.

import DOMPurify from "dompurify";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "../editor/extensions";

// 마크다운으로 표현 가능한 의미 구조만 남긴다. 스크립트/스타일/폼/임베드 등
// 위험하거나 마크다운에 의미 없는 태그는 통째로 제거한다. (KEEP_CONTENT 기본값이
// 태그를 풀고 내용만 남겨, 본문 텍스트는 유실되지 않는다.)
const SANITIZE_CONFIG = {
  // 스크립트/스타일/이벤트핸들러는 DOMPurify가 기본 제거하지만 명시해 의도를 못박는다.
  FORBID_TAGS: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "base",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "link",
    "meta",
    "noscript",
  ],
  // on* 핸들러는 ALLOWED_ATTR로 자연히 떨어지지만, 위험 속성을 명시 차단한다.
  FORBID_ATTR: ["style", "srcset"],
  // <body> 안의 조각만 받는다 — 전체 문서가 와도 <head> 메타는 버린다.
  WHOLE_DOCUMENT: false,
};

const UNSAFE_HREF_RE = /^\s*(javascript|data|vbscript):/i;

/**
 * 신뢰할 수 없는 HTML을 마크다운 변환에 안전한 형태로 정화한다.
 *
 * - 스크립트/스타일/폼/임베드 제거 (위 SANITIZE_CONFIG)
 * - javascript:/vbscript:/data: 링크 목적지 제거 (활성 위험 링크 차단)
 * - 그 외 구조(헤딩/목록/표/코드/링크/이미지/강조)는 보존
 */
export function sanitizeForMarkdown(html: string): string {
  const hook = (node: Element) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (UNSAFE_HREF_RE.test(href)) node.removeAttribute("href");
      // 새 창/탑 네비게이션 유발 속성 제거
      node.removeAttribute("target");
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (UNSAFE_HREF_RE.test(src)) node.removeAttribute("src");
    }
  };

  DOMPurify.addHook("afterSanitizeAttributes", hook);
  try {
    return DOMPurify.sanitize(html, SANITIZE_CONFIG);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", hook);
  }
}

/**
 * HTML을 편집 가능한 마크다운 문자열로 변환한다 (FR-3.4).
 *
 * 입력은 정화 후 에디터와 동일한 tiptap 구성으로 파싱·직렬화하므로,
 * 결과 마크다운은 그대로 노트로 저장해도 라운드트립이 안전하다.
 */
export function htmlToMarkdown(html: string): string {
  const safe = sanitizeForMarkdown(html);
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: safe,
  });
  try {
    return getMarkdown(editor).trim();
  } finally {
    editor.destroy();
  }
}
