// .drawio(mxGraph XML) 파일을 다이어그램으로 렌더링하는 뷰어 문서를 만든다.
//
// HtmlViewer와 같은 격리 전략을 쓴다: 여기서 만든 HTML을 캐시에 쓰고 sandbox
// iframe(allow-scripts)으로 로드한다. 렌더링은 drawio의 자기완결형(static) 뷰어
// 런타임이 담당한다 — `.mxgraph` 엘리먼트를 스크립트 로드 시점에 자동으로 찾아
// (`GraphViewer.processElements`) 다이어그램으로 바꾼다. 뷰어 JS는 오프라인에서
// 동작하도록 앱에 번들로 포함되어 있고(viewer-static.min.js), 캐시에 한 번 쓴 뒤
// 그 asset URL을 여기로 넘겨받는다.

/** 단일/이중 인용 HTML 속성값에 안전하게 넣을 수 있도록 이스케이프한다. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const VIEWER_STYLE = `
  html, body { margin: 0; height: 100%; background: #fff; }
  body { font-family: -apple-system, "Pretendard", "Noto Sans KR", sans-serif; }
  .mxgraph { max-width: 100%; }
  /* 빈/깨진 다이어그램일 때 뷰어가 남기는 에러 텍스트 */
  .mxgraph:empty::before { content: ""; }
`;

/**
 * drawio XML을 받아 뷰어 iframe에 넣을 완성된 HTML 문서를 만든다.
 *
 * 다이어그램은 작성 당시의 색을 그대로 쓰므로 앱 테마와 무관하게 항상 흰
 * 캔버스로 렌더링한다. drawio의 다크 모드는 캔버스/크롬만 어둡게 할 뿐 도형 색은
 * 바꾸지 않아, 라이트로 그린 다이어그램이 어두운 캔버스 위에서 검정-위-검정으로
 * 안 보이는 문제가 있다. (drawioEmbed.buildEditorUrl 도 같은 이유로 dark 미적용.)
 *
 * @param xml    `.drawio` 파일 원문 (`<mxfile>...` 또는 `<mxGraphModel>...`).
 *               압축(base64+deflate)된 diagram 내용도 뷰어 런타임이 직접 푼다.
 * @param viewerScriptUrl  번들된 viewer-static.min.js의 (캐시) asset URL.
 *               iframe과 같은 출처여야 로드된다.
 */
export function buildDrawioHtml(xml: string, viewerScriptUrl: string): string {
  // GraphViewer는 data-mxgraph 속성에 JSON 설정을 기대한다. xml 자체를 그 안에
  // 문자열로 담는다. (lightbox는 새 창을 열어 sandbox에서 막히므로 끈다.)
  const config = {
    highlight: "#3572b0",
    nav: true,
    resize: true,
    lightbox: false,
    "toolbar-position": "top",
    toolbar: "zoom layers tags pages",
    xml,
  };
  // JSON을 단일 인용 속성에 넣는다 — 내부 큰따옴표는 그대로 두고, 속성/HTML 파싱을
  // 깨뜨릴 수 있는 문자만 엔티티로 바꾼다.
  const dataAttr = JSON.stringify(config)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>${VIEWER_STYLE}</style></head><body>` +
    `<div class="mxgraph" data-mxgraph='${dataAttr}'></div>` +
    `<script src="${escapeAttr(viewerScriptUrl)}"></script>` +
    `</body></html>`
  );
}
