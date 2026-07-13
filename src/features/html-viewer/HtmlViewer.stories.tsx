// HtmlViewer 워크벤치 스토리. drawio 뷰어와 같은 격리 방식(캐시 HTML → sandbox
// iframe)을 쓰므로, 라이트/다크에서 렌더가 정상인지 함께 확인하는 기준점이 된다.
import type { Story } from "@ladle/react";
import { useState } from "react";
import { useWorkspace } from "../../stores/workspace";
import { ThemeFrame } from "../../ladle/ThemeFrame";
import { HtmlViewer } from "./HtmlViewer";

const PATH = "/mock/notes/ai/summary.html";
const SAMPLE_HTML =
  "<h1>AI 요약</h1><p>HTML 뷰어 데모 문서입니다.</p><ul><li>첫째</li><li>둘째</li></ul>";

function ViewerWithContent({ theme }: { theme: "light" | "dark" }) {
  useState(() => {
    useWorkspace.setState((s) => ({
      docs: {
        ...s.docs,
        [PATH]: {
          content: SAMPLE_HTML,
          savedContent: SAMPLE_HTML,
          externalRev: 0,
          externalStale: false,
          loading: false,
          error: null,
        },
      },
    }));
    return null;
  });
  return (
    <ThemeFrame theme={theme}>
      <HtmlViewer path={PATH} />
    </ThemeFrame>
  );
}

export const Light: Story = () => <ViewerWithContent theme="light" />;
export const Dark: Story = () => <ViewerWithContent theme="dark" />;
