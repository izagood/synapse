import { useCallback, useMemo, useRef } from "react";
import { Excalidraw, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useWorkspace } from "../../stores/workspace";
import { effectiveTheme, useSettings } from "../../stores/settings";
import { useT } from "../../i18n";
import { parseSceneContent } from "./scene";

// 오프라인(Tauri WebView)에서도 손글씨 폰트를 로컬에서 불러오도록 자산 경로를 고정한다.
// 미설정 시 Excalidraw는 esm.sh CDN에서 폰트를 받는다(오프라인이면 시스템 폰트로 폴백).
// 폰트는 빌드 시 scripts/copy-excalidraw-assets.mjs 가 public/excalidraw-assets/ 로 복사한다.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}
if (typeof window !== "undefined" && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
}

type ExcalidrawOnChange = NonNullable<
  React.ComponentProps<typeof Excalidraw>["onChange"]
>;
type ExcalidrawInitialData = React.ComponentProps<typeof Excalidraw>["initialData"];

/**
 * `.excalidraw` 드로잉 편집기. 노트와 달리 CRDT가 아니라 단순 파일 저장 경로를 탄다
 * (workspace.saveDoc: 마크다운이 아니면 writeFile). 장면의 로드/직렬화는 Excalidraw가
 * export하는 검증된 유틸(restore/serializeAsJSON)을 그대로 쓴다.
 */
export default function ExcalidrawEditor({ path }: { path: string }) {
  const updateContent = useWorkspace((s) => s.updateContent);
  const theme = useSettings((s) => s.settings.appearance.theme);
  const t = useT();

  // 마운트 시점의 디스크 내용으로 초기 장면을 만든다. 외부 변경(원격 머지 등)은
  // ContentPane이 externalRev를 key에 넣어 리마운트하므로 여기선 한 번만 읽으면 된다.
  // 손상/비-excalidraw 파일은 parseSceneContent가 걸러내고(아래 error), 정상 장면은
  // Excalidraw의 restore()로 검증·정규화해 initialData로 넘긴다.
  const initial = useMemo(() => {
    const content = useWorkspace.getState().docs[path]?.content ?? "";
    const parsed = parseSceneContent(content);
    if (!parsed) return { error: true as const };
    if (parsed.kind === "empty") return { data: null as ExcalidrawInitialData };
    const data = restore(
      parsed.data as Parameters<typeof restore>[0],
      null,
      null,
    ) as ExcalidrawInitialData;
    return { data };
  }, [path]);

  // 저장 비교 기준(직렬화 문자열). Excalidraw onChange는 마운트 직후와 팬/줌 때도
  // 발생하므로, 직렬화 결과가 같으면 저장하지 않아 헛 저장·헛 dirty를 막는다.
  const lastSavedRef = useRef<string | null>(null);

  const onChange = useCallback<ExcalidrawOnChange>(
    (elements, appState, files) => {
      const json = serializeAsJSON(elements, appState, files, "local");
      if (lastSavedRef.current === null) {
        // 첫 onChange = 초기 장면. 기준만 잡고 저장하지 않는다.
        lastSavedRef.current = json;
        return;
      }
      if (json === lastSavedRef.current) return;
      lastSavedRef.current = json;
      updateContent(path, json);
    },
    [path, updateContent],
  );

  if ("error" in initial) {
    return (
      <div className="preview-placeholder">
        <p className="error">{t("viewer.excalidrawError")}</p>
      </div>
    );
  }

  return (
    <div className="excalidraw-host">
      <Excalidraw
        initialData={initial.data}
        onChange={onChange}
        theme={effectiveTheme(theme)}
      />
    </div>
  );
}
