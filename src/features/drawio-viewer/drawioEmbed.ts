// 번들된 drawio 에디터 웹앱(public/vendor/drawio-app/)을 iframe embed 모드로
// 띄우고 postMessage(JSON 프로토콜)로 주고받기 위한 순수 로직.
//
// 프로토콜 요약 (proto=json):
//   iframe → host  {event:'init'}            준비 완료 → host가 load 응답
//   host  → iframe {action:'load', xml, autosave:1}
//   iframe → host  {event:'autosave', xml}   편집 중 자동 저장
//   iframe → host  {event:'save', xml, exit} 저장(또는 저장 후 종료)
//   iframe → host  {event:'exit'}            종료
// 참고: https://github.com/jgraph/drawio (embed mode, proto=json)

export interface EmbedUrlOptions {
  /** 번들된 에디터 진입점 경로. 보통 "vendor/drawio-app/index.html". */
  basePath: string;
  /** UI 언어 (번들된 resources/dia_<lang>.txt 가 있을 때만 적용됨). */
  lang?: string;
}

/**
 * embed 모드 진입 URL을 만든다.
 *
 * 다크는 일부러 켜지 않는다 — drawio 다크 모드는 캔버스/크롬만 어둡게 할 뿐 도형
 * 색은 그대로라, 라이트로 그린 다이어그램이 검정-위-검정으로 안 보인다.
 * 앱 테마와 무관하게 항상 라이트 캔버스로 편집한다. (buildDrawioHtml 도 동일.)
 */
export function buildEditorUrl(opts: EmbedUrlOptions): string {
  const params = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1", // 로딩 스피너
    libraries: "1", // 도형 라이브러리 패널
    noSaveBtn: "1", // 자동 저장이므로 명시적 저장 버튼 숨김
    noExitBtn: "1", // 종료는 앱에서 모드 전환으로 처리
    saveAndExit: "0",
    offline: "1", // 클라우드/스토리지 기능 비활성
    stealth: "1", // 외부 네트워크 요청 차단 (오프라인 보장)
  });
  if (opts.lang) params.set("lang", opts.lang);
  return `${opts.basePath}?${params.toString()}`;
}

/**
 * mxGraph XML 이 "빈 다이어그램"인지 판단한다 — 비었거나 공백뿐이거나, 사용자가
 * 그린 도형/엣지/객체가 하나도 없는 기본 골격(default layer cell 만)인 경우.
 *
 * 압축 저장된 `<diagram>base64…</diagram>`(내부에 `<` 가 없는 페이로드)은
 * 내용이 있는 것으로 본다 — 잘못 빈 것으로 판정해 보호를 못 하는 일이 없도록
 * 보수적으로 처리한다.
 */
export function isBlankDrawio(xml: string | null | undefined): boolean {
  if (typeof xml !== "string") return true;
  const trimmed = xml.trim();
  if (trimmed === "") return true;
  // 압축(deflate+base64) 페이로드: <diagram> 안에 마크업(<) 없이 텍스트만 들어 있다.
  const diagram = trimmed.match(/<diagram\b[^>]*>([\s\S]*?)<\/diagram>/i);
  if (diagram && !diagram[1].includes("<") && diagram[1].replace(/\s/g, "").length > 16) {
    return false;
  }
  // 사용자 도형/엣지/객체가 하나라도 있으면 내용 있음.
  return !/vertex\s*=\s*"1"|edge\s*=\s*"1"|<(?:object|UserObject)\b/i.test(trimmed);
}

/**
 * 에디터가 보낸 새 XML 을 파일에 저장해도 되는지 판단한다.
 *
 * 시드(initialXml)에 내용이 있었는데 새 XML 이 빈 다이어그램이면, 로드 실패나
 * 초기화 사고로 보고 저장을 거부한다 — 기존 파일이 빈 내용으로 덮어써지는
 * 데이터 손실을 막는 안전장치. (원래 빈 파일에서 시작했다면 빈 저장도 허용.)
 */
export function shouldPersistDrawio(newXml: string, initialXml: string): boolean {
  if (isBlankDrawio(newXml)) return isBlankDrawio(initialXml);
  return true;
}

/**
 * iframe → host 메시지가 이 에디터의 iframe 에서 온 것으로 신뢰할 수 있는지 본다.
 *
 * 정상 브라우저에선 MessageEvent.source 가 iframe 의 contentWindow 와 같아서
 * `source === frame` 으로 거르면 된다. 그러나 macOS 의 WKWebView(Tauri 셸)는
 * iframe→부모 postMessage 에서 source 를 null 로 주는 버그가 있다. 그 경우
 * 엄격히 비교하면 drawio 가 보내는 init 이 통째로 버려지고 load 핸드셰이크가
 * 끝내 완료되지 않아, 에디터가 빈 캔버스로 멈춘 채 파일이 로드되지 않는다
 * (그래서 뷰어는 멀쩡한데 에디터만 빈칸으로 보였다).
 *
 * 따라서 source 가 있으면 그대로 일치를 요구하고, source 가 없을 때(WKWebView)는
 * 통과시킨다 — 데스크톱 앱이라 신뢰 못 할 외부 프레임이 없고, 실제 drawio embed
 * 이벤트인지는 handleEmbedEvent 가 한 번 더 거른다.
 */
export function isFromEmbedFrame(
  source: MessageEventSource | null,
  frame: Window | null | undefined,
): boolean {
  if (source == null) return true; // WKWebView: source 미제공 → 신뢰
  return source === frame;
}

export interface EmbedContext {
  /** 에디터를 처음 띄울 때 로드할 .drawio XML 원문. */
  initialXml: string;
}

export interface EmbedOutcome {
  /** iframe 으로 되돌려 보낼 메시지(JSON 직렬화 전 객체). */
  reply?: Record<string, unknown>;
  /** 파일로 저장해야 할 XML (autosave/save 이벤트). */
  saveXml?: string;
  /** 에디터 종료 요청. */
  exit?: boolean;
}

/**
 * iframe 이 보낸 embed 이벤트(파싱된 객체)를 받아 호스트가 취할 동작을 돌려준다.
 * 다루지 않는 이벤트는 null.
 */
export function handleEmbedEvent(data: unknown, ctx: EmbedContext): EmbedOutcome | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as { event?: string; xml?: string; exit?: boolean };
  switch (msg.event) {
    case "init":
      // 준비되면 현재 문서를 자동 저장 모드로 로드한다.
      return { reply: { action: "load", autosave: 1, xml: ctx.initialXml } };
    case "autosave":
      return typeof msg.xml === "string" ? { saveXml: msg.xml } : null;
    case "save":
      return {
        ...(typeof msg.xml === "string" ? { saveXml: msg.xml } : {}),
        ...(msg.exit ? { exit: true } : {}),
      };
    case "exit":
      return { exit: true };
    default:
      return null;
  }
}
