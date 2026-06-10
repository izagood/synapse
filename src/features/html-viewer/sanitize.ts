import DOMPurify from "dompurify";

export interface SanitizeOptions {
  /** 문서 기준 디렉토리의 상대 경로를 webview가 로드 가능한 URL로 변환 */
  resolveLocal: (relativePath: string) => string;
  /** 외부(http/https) 리소스 허용 여부 — 기본 차단 (FR-3.2) */
  allowNetwork?: boolean;
}

const EXTERNAL_RE = /^(https?:)?\/\//i;

/**
 * AI 산출물 등 신뢰할 수 없는 HTML을 뷰어에 넣기 전에 정화한다 (NFR-4).
 *
 * - 스크립트/이벤트 핸들러/iframe 제거 (DOMPurify 기본 + 명시 금지)
 * - 외부 네트워크 리소스(src/href) 기본 차단, data: 이미지는 허용
 * - 상대 경로 이미지는 resolveLocal로 재작성 (Tauri asset protocol)
 * - 문서 자체 <style>은 보존 — AI가 만든 보기 좋은 스타일이 핵심 가치
 */
export function sanitizeHtml(html: string, options: SanitizeOptions): string {
  const { resolveLocal, allowNetwork = false } = options;

  const hook = (node: Element) => {
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (EXTERNAL_RE.test(src)) {
        if (!allowNetwork) node.removeAttribute("src");
      } else if (src && !src.startsWith("data:")) {
        node.setAttribute("src", resolveLocal(src));
      }
    }
    if (node.tagName === "A") {
      // 새 창/탑 네비게이션 방지. 외부 링크는 target 제거 후 그대로 표기만.
      node.removeAttribute("target");
    }
  };

  DOMPurify.addHook("afterSanitizeAttributes", hook);
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ["iframe", "object", "embed", "base", "form", "link", "meta"],
      FORBID_ATTR: ["srcset"],
      WHOLE_DOCUMENT: true,
    });
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", hook);
  }
}
