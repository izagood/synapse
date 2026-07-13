// ExcalidrawEditor 워크벤치 스토리.
//
// 실제 Excalidraw 번들을 mock 백엔드(브라우저 모드) 위에서 그대로 렌더한다.
// 앱 테마(크롬)와 캔버스 테마(appearance.canvasTheme)를 따로 두어, "다크 앱인데
// 캔버스는 밝게" 같은 조합을 눈으로 검증한다. 메뉴(☰)를 열어 "열기/라이브 협업"이
// 없는지, 임베드 이미지가 보이는지도 손으로 확인한다.
import type { Story } from "@ladle/react";
import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useSettings } from "../../stores/settings";
import type { CanvasTheme } from "../../ipc/types";
import { ThemeFrame } from "../../ladle/ThemeFrame";
import ExcalidrawEditor from "./ExcalidrawEditor";
import { SAMPLE_EXCALIDRAW_JSON, BLANK_EXCALIDRAW_JSON } from "./fixtures";

const PATH = "/mock/notes/drawings/sketch.excalidraw";

// 워크스페이스 스토어에 문서를, 설정 스토어에 앱/캔버스 테마를 미리 채운다.
// ExcalidrawEditor 는 마운트 시점에 docs[path].content(useMemo)와 appearance
// (effectiveCanvasTheme → theme prop)를 읽으므로, 자식 마운트 전에 동기 시드해야
// 한다. useState 초기화 함수는 부모 첫 렌더 중 한 번만 실행되어 이 보장을 만족한다.
function EditorWithContent({
  content,
  appTheme,
  canvasTheme,
}: {
  content: string;
  appTheme: "light" | "dark";
  canvasTheme: CanvasTheme;
}) {
  useState(() => {
    useWorkspace.setState((s) => ({
      docs: {
        ...s.docs,
        [PATH]: {
          content,
          savedContent: content,
          externalRev: 0,
          externalStale: false,
          loading: false,
          error: null,
        },
      },
    }));
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        appearance: { ...s.settings.appearance, theme: appTheme, canvasTheme },
      },
    }));
    return null;
  });
  return (
    <ThemeFrame theme={appTheme}>
      <ExcalidrawEditor path={PATH} />
    </ThemeFrame>
  );
}

export const CanvasLight: Story = () => (
  <EditorWithContent content={SAMPLE_EXCALIDRAW_JSON} appTheme="light" canvasTheme="light" />
);

export const CanvasDark: Story = () => (
  <EditorWithContent content={SAMPLE_EXCALIDRAW_JSON} appTheme="dark" canvasTheme="dark" />
);

// 핵심 동작: 앱 크롬은 어둡지만(ThemeFrame dark) 캔버스는 밝다(canvasTheme light).
// 다크 테마 사용자가 excalidraw 배경이 어두워지는 문제를 푸는 설정이 이것이다.
export const DarkAppLightCanvas: Story = () => (
  <EditorWithContent content={SAMPLE_EXCALIDRAW_JSON} appTheme="dark" canvasTheme="light" />
);

// 빈 장면: 에디터가 깨지지 않고 빈 캔버스로(에러 텍스트 없이) 떠야 한다.
export const BlankDrawing: Story = () => (
  <EditorWithContent content={BLANK_EXCALIDRAW_JSON} appTheme="dark" canvasTheme="light" />
);
