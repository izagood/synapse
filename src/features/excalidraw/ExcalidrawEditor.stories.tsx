// ExcalidrawEditor 워크벤치 스토리.
//
// 실제 Excalidraw 번들을 mock 백엔드(브라우저 모드) 위에서 그대로 렌더한다.
// 라이트/다크를 나란히 두어 "다크 캔버스에서 도형/이미지가 안 보이는" 류의 시각
// 회귀를 코딩하며 바로 눈으로 확인하고, 메뉴(☰)를 열어 "열기/라이브 협업"이
// 없는지, 임베드 이미지가 보이는지도 손으로 검증한다.
import type { Story } from "@ladle/react";
import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { useSettings } from "../../stores/settings";
import { ThemeFrame } from "../../ladle/ThemeFrame";
import ExcalidrawEditor from "./ExcalidrawEditor";
import { SAMPLE_EXCALIDRAW_JSON, BLANK_EXCALIDRAW_JSON } from "./fixtures";

const PATH = "/mock/notes/drawings/sketch.excalidraw";

// 워크스페이스 스토어에 문서를, 설정 스토어에 테마를 미리 채운다. ExcalidrawEditor
// 는 마운트 시점에 docs[path].content 와 settings.appearance.theme 를 읽으므로(전자는
// useMemo, 후자는 Excalidraw theme prop), 자식 마운트 전에 동기 시드해야 한다.
// useState 초기화 함수는 부모 첫 렌더 중 한 번만 실행되어 이 보장을 만족한다.
function EditorWithContent({
  content,
  theme,
}: {
  content: string;
  theme: "light" | "dark";
}) {
  useState(() => {
    useWorkspace.setState((s) => ({
      docs: {
        ...s.docs,
        [PATH]: {
          content,
          savedContent: content,
          externalRev: 0,
          loading: false,
          error: null,
        },
      },
    }));
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        appearance: { ...s.settings.appearance, theme },
      },
    }));
    return null;
  });
  return (
    <ThemeFrame theme={theme}>
      <ExcalidrawEditor path={PATH} />
    </ThemeFrame>
  );
}

export const DrawingLight: Story = () => (
  <EditorWithContent content={SAMPLE_EXCALIDRAW_JSON} theme="light" />
);

export const DrawingDark: Story = () => (
  <EditorWithContent content={SAMPLE_EXCALIDRAW_JSON} theme="dark" />
);

// 빈 장면: 에디터가 깨지지 않고 빈 캔버스로(에러 텍스트 없이) 떠야 한다.
export const BlankDrawing: Story = () => (
  <EditorWithContent content={BLANK_EXCALIDRAW_JSON} theme="dark" />
);
