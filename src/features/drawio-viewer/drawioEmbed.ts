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
  /** 다크 테마로 띄울지. */
  dark?: boolean;
  /** UI 언어 (번들된 resources/dia_<lang>.txt 가 있을 때만 적용됨). */
  lang?: string;
}

/** embed 모드 진입 URL을 만든다. */
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
  if (opts.dark) params.set("dark", "1");
  if (opts.lang) params.set("lang", opts.lang);
  return `${opts.basePath}?${params.toString()}`;
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
