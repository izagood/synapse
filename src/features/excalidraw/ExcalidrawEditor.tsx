import { useCallback, useMemo, useRef } from "react";
import { Excalidraw, MainMenu, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useWorkspace } from "../../stores/workspace";
import { effectiveCanvasTheme, useSettings } from "../../stores/settings";
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

// synapse는 워크스페이스 파일 + autosave 모델이다. Excalidraw 기본 UI 중 브라우저
// 파일시스템/협업에 묶인 항목은 이 모델과 충돌하므로 끈다. 나머지(모든 그리기 도구,
// 라이브러리 사이드바, 줌, 컨텍스트 메뉴, 이미지로 내보내기)는 네이티브 그대로 둔다.
// 모듈 상수로 두어 매 렌더 참조가 바뀌지 않게 한다.
const UI_OPTIONS = {
  canvasActions: {
    loadScene: false, // "열기"(브라우저 파일 열기) — 현재 캔버스를 덮어써 워크스페이스 모델과 충돌
    saveToActiveFile: false, // "파일로 저장"(브라우저 저장) — autosave가 워크스페이스 파일에 저장
    export: false as const, // .excalidraw 파일 import/export — synapse 파일 자체가 곧 .excalidraw
    toggleTheme: false, // 테마는 synapse 설정(effectiveTheme)이 소유
    saveAsImage: true, // PNG/SVG/클립보드 내보내기 — 네이티브 가치, 유지
    changeViewBackgroundColor: true,
    clearCanvas: true,
  },
};

/**
 * `.excalidraw` 드로잉 편집기. 노트와 달리 CRDT가 아니라 단순 파일 저장 경로를 탄다
 * (workspace.saveDoc: 마크다운이 아니면 writeFile). 장면의 로드/직렬화는 Excalidraw가
 * export하는 검증된 유틸(restore/serializeAsJSON)을 그대로 쓴다.
 */
export default function ExcalidrawEditor({ path }: { path: string }) {
  const updateContent = useWorkspace((s) => s.updateContent);
  // 캔버스 테마는 앱 테마와 별개(appearance.canvasTheme)로 정한다 — 다크 앱에서도
  // 캔버스를 밝게 둘 수 있다. canvasTheme 변경 시 구독으로 리렌더되어 prop이 전파된다.
  const appearance = useSettings((s) => s.settings.appearance);
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
        theme={effectiveCanvasTheme(appearance)}
        UIOptions={UI_OPTIONS}
      >
        {/* 메인메뉴를 명시 구성해 "열기/파일로 저장/내보내기(파일)/라이브 협업/테마
            토글"을 제외하고, synapse 파일 모델과 맞는 항목만 남긴다. */}
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
