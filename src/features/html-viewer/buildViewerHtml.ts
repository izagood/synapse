import { sanitizeHtml } from "./sanitize";

export interface ViewerOptions {
  /** 문서 기준 디렉토리의 asset URL — 상대 경로(이미지·CSS·JS) 해석용 <base> */
  baseUrl: string;
  resolveLocal: (rel: string) => string;
  allowScripts: boolean;
  allowNetwork: boolean;
}

const VIEWER_STYLE = `
  body { margin: 24px auto; max-width: 860px; padding: 0 24px;
         font-family: -apple-system, "Pretendard", "Noto Sans KR", sans-serif;
         line-height: 1.7; background: #fff; color: #1a1a1a; }
  img { max-width: 100%; }
`;

function injectIntoHead(html: string, inject: string): string {
  // 완전한 문서면 <head> 안에, 조각이면 문서로 감싼다
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${inject}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${inject}</head><body>${html}</body></html>`;
}

/**
 * HTML 뷰어에 넣을 최종 문서를 만든다 (FR-3).
 *
 * - 기본: DOMPurify 정화(스크립트/iframe/외부 리소스 제거) + 기본 스타일
 * - 스크립트 허용(설정에서 명시적으로 켠 경우): 정화를 건너뛰고 원문 그대로 —
 *   스크립트를 살리면서 정화하는 것은 보안 환상이므로 솔직하게 전부 허용하되,
 *   iframe sandbox(같은 출처/탑 네비게이션/Tauri API 차단)가 격리를 담당한다.
 * - 두 모드 모두 <base>를 주입해 상대 경로가 원본 폴더 기준으로 해석되게 한다.
 */
export function buildViewerHtml(content: string, options: ViewerOptions): string {
  const { baseUrl, resolveLocal, allowScripts, allowNetwork } = options;
  const base = `<base href="${baseUrl.replace(/"/g, "%22")}/">`;

  if (allowScripts) {
    return injectIntoHead(content, base);
  }

  const sanitized = sanitizeHtml(content, { resolveLocal, allowNetwork });
  const hasOwnStyle = /<style[\s>]|<link/i.test(sanitized);
  const style = hasOwnStyle ? "" : `<style>${VIEWER_STYLE}</style>`;
  return injectIntoHead(sanitized, base + style);
}
