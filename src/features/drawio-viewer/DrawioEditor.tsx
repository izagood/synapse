import { useEffect, useRef } from "react";
import { useWorkspace } from "../../stores/workspace";
import { effectiveTheme, useSettings } from "../../stores/settings";
import { buildEditorUrl, handleEmbedEvent } from "./drawioEmbed";

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
  const theme = useSettings((s) => s.settings.appearance.theme);
  const lang = useSettings((s) => s.settings.appearance.language);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // 마운트 시점의 내용을 한 번만 캡처한다. 이후 autosave 가 스토어 content 를
  // 갱신해도 에디터를 다시 로드하지 않는다(에디터가 진실의 원천).
  const initialXml = useRef(doc?.content ?? "");

  // src 는 마운트 시 한 번만 계산한다. 편집 중 테마/언어가 바뀌어 iframe 이
  // 리로드되며 작업이 끊기지 않도록 의존성에서 제외한다.
  const src = useRef(
    buildEditorUrl({
      basePath: APP_PATH,
      dark: effectiveTheme(theme) === "dark",
      lang,
    }),
  );

  useEffect(() => {
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
      const outcome = handleEmbedEvent(data, { initialXml: initialXml.current });
      if (!outcome) return;
      if (outcome.reply) {
        frame.contentWindow?.postMessage(JSON.stringify(outcome.reply), "*");
      }
      if (typeof outcome.saveXml === "string") {
        updateContent(path, outcome.saveXml);
      }
      if (outcome.exit) onExit?.();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [path, updateContent, onExit]);

  return <iframe ref={frameRef} className="drawio-editor" title={path} src={src.current} />;
}
