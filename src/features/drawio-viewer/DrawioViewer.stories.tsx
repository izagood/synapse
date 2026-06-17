// DrawioViewer 워크벤치 스토리.
//
// 실제 컴포넌트를 mock 백엔드(브라우저 모드) 위에서 그대로 렌더한다 — 번들된
// drawio 뷰어 런타임(public/vendor/drawio/)이 iframe 안에서 진짜 다이어그램을
// 그린다. 라이트/다크를 나란히 두어 "다크 캔버스에서 도형이 안 보이는" 류의
// 시각 회귀를 코딩하면서 바로 눈으로 확인할 수 있다.
import type { Story } from "@ladle/react";
import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { ThemeFrame } from "../../ladle/ThemeFrame";
import { DrawioViewer } from "./DrawioViewer";
import { SAMPLE_DRAWIO_XML, BLANK_DRAWIO_XML } from "./fixtures";

const PATH = "/mock/notes/diagrams/flow.drawio";

// 워크스페이스 스토어에 문서를 미리 채워, DrawioViewer 가 마운트 즉시 내용을
// 읽도록 한다. useState 초기화 함수는 부모 첫 렌더 중(자식 마운트 전) 한 번만
// 실행되므로 동기 시드에 안전하다.
function ViewerWithContent({
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
    return null;
  });
  return (
    <ThemeFrame theme={theme}>
      <DrawioViewer path={PATH} />
    </ThemeFrame>
  );
}

export const DiagramLight: Story = () => (
  <ViewerWithContent content={SAMPLE_DRAWIO_XML} theme="light" />
);

export const DiagramDark: Story = () => (
  <ViewerWithContent content={SAMPLE_DRAWIO_XML} theme="dark" />
);

// 빈 다이어그램: 뷰어가 깨지지 않고 비어 있게(에러 텍스트 없이) 떠야 한다.
export const BlankDiagram: Story = () => (
  <ViewerWithContent content={BLANK_DRAWIO_XML} theme="dark" />
);
