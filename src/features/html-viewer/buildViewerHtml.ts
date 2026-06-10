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

// 정화 이후에 주입되는 뷰어 런타임 (문서 내용이 이 스크립트에 끼어들 수 없다):
// - <base> 때문에 깨지는 # 앵커 클릭을 같은 문서 스크롤로 처리
// - 외부 링크는 부모(앱)에 알려 시스템 브라우저로 연다
// 문서 자체 스크립트가 허용된 경우, 문서가 직접 처리(preventDefault)한 클릭은 건드리지 않는다.
const VIEWER_RUNTIME = `<script>
document.addEventListener("click", function (e) {
  if (e.defaultPrevented) return;
  var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
  if (!a) return;
  var href = a.getAttribute("href") || "";
  if (href.charAt(0) === "#") {
    e.preventDefault();
    var id = decodeURIComponent(href.slice(1));
    var el = document.getElementById(id) ||
      document.querySelector('[name="' + id.replace(/"/g, "") + '"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (/^https?:\\/\\//i.test(href)) {
    e.preventDefault();
    parent.postMessage({ type: "synapse:open-external", href: href }, "*");
  }
});
</script>`;

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
  return `<!doctype html><html><head>${inject}</head><body>${html}</body></html>`;
}

/**
 * HTML 뷰어에 넣을 최종 문서를 만든다 (FR-3).
 *
 * - 기본: DOMPurify 정화(스크립트/iframe/외부 리소스 제거) + 기본 스타일
 * - 스크립트 허용(설정에서 명시적으로 켠 경우): 정화를 건너뛰고 원문 그대로 —
 *   iframe sandbox(같은 출처/탑 네비게이션/Tauri API 차단)가 격리를 담당한다.
 * - 공통 주입: <meta charset> (정화가 meta를 제거해 한글이 깨지는 문제 방지),
 *   <base> (상대 경로 해석), 뷰어 런타임(# 앵커 스크롤·외부 링크 열기)
 */
export function buildViewerHtml(content: string, options: ViewerOptions): string {
  const { baseUrl, resolveLocal, allowScripts, allowNetwork } = options;
  // charset이 base보다 먼저 와야 인코딩 추측이 끼어들 틈이 없다
  const head =
    `<meta charset="utf-8">` + `<base href="${baseUrl.replace(/"/g, "%22")}/">`;

  if (allowScripts) {
    return injectIntoHead(content, head) + VIEWER_RUNTIME;
  }

  const sanitized = sanitizeHtml(content, { resolveLocal, allowNetwork });
  const hasOwnStyle = /<style[\s>]|<link/i.test(sanitized);
  const style = hasOwnStyle ? "" : `<style>${VIEWER_STYLE}</style>`;
  return injectIntoHead(sanitized, head + style) + VIEWER_RUNTIME;
}
