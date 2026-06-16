import { useEffect, useRef } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useSettings } from "../../stores/settings";
import { useT } from "../../i18n";
import { buildEditorUrl, handleEmbedEvent, shouldPersistDrawio } from "./drawioEmbed";

// 앱에 번들된 drawio 에디터 웹앱(public/ → dist 루트로 복사됨). 앱과 같은
// 출처라 iframe 안 문서는 메인 윈도우 CSP 제약을 받지 않고 그대로 동작한다.
const APP_PATH = "vendor/drawio-app/index.html";

// `.drawio` 파일을 번들된 drawio 에디터로 편집한다. 저장은 embed 프로토콜의
// autosave/save 이벤트로 들어온 XML을 워크스페이스 스토어에 흘려보내면, 스토어가
// (마크다운이 아니므로) 평문 writeFile 경로로 파일에 그대로 쓴다 — frontmatter
// 주입이 없어 XML이 깨지지 않는다.
export function DrawioEditor({ path, onExit }: { path: string; onExit?: () => void }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const updateContent = useWorkspace((s) => s.updateContent);
  const lang = useSettings((s) => s.settings.appearance.language);
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);

  // 시드(편집 시작 내용)는 파일 내용이 실제로 로드된 뒤에만 한 번 캡처한다.
  // 로딩 중(content="")에 잡으면 빈 시드로 에디터가 떠서, 그 빈 내용이 곧장
  // autosave 되며 기존 파일을 덮어쓰는 데이터 손실이 난다. 캡처 전까지는 iframe 을
  // 띄우지 않고 대기한다. 한 번 잡은 뒤엔 이후 autosave 가 스토어 content 를
  // 갱신해도 다시 읽지 않는다(에디터가 진실의 원천).
  const initialXml = useRef<string | null>(null);
  if (initialXml.current === null && doc && !doc.loading && doc.error === null) {
    initialXml.current = doc.content ?? "";
  }
  const seed = initialXml.current;

  // src 는 시드 준비 후 한 번만 계산한다. 편집 중 언어가 바뀌어 iframe 이
  // 리로드되며 작업이 끊기지 않도록 의존성에서 제외한다.
  const src = useRef<string | null>(null);
  if (src.current === null && seed !== null) {
    src.current = buildEditorUrl({ basePath: APP_PATH, lang });
  }

  useEffect(() => {
    if (seed === null) return; // 시드가 아직 준비 안 됨 — iframe 도 안 떠 있다.
    const loadedSeed = seed; // 아래 콜백 클로저에서 string 으로 좁혀 쓰기 위해 고정.
    function onMessage(e: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      let data: unknown = e.data;
      if (typeof data === "string") {
        if (data.length === 0) return; // drawio 가 가끔 빈 문자열을 먼저 보냄
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const outcome = handleEmbedEvent(data, { initialXml: loadedSeed });
      if (!outcome) return;
      if (outcome.reply) {
        frame.contentWindow?.postMessage(JSON.stringify(outcome.reply), "*");
      }
      // 시드에 내용이 있었는데 빈 다이어그램이 들어오면 저장하지 않는다(손실 방지).
      if (typeof outcome.saveXml === "string" && shouldPersistDrawio(outcome.saveXml, loadedSeed)) {
        updateContent(path, outcome.saveXml);
      }
      if (outcome.exit) onExit?.();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [path, updateContent, onExit, seed]);

  if (seed === null || src.current === null) {
    return (
      <div className="preview-placeholder">
        <p>{t("viewer.preparing")}</p>
      </div>
    );
  }

  return <iframe ref={frameRef} className="drawio-editor" title={path} src={src.current} />;
}
