import type { MermaidConfig } from "mermaid";

// ```mermaid 코드 블록을 다이어그램으로 렌더링하기 위한 얇은 래퍼.
// mermaid 번들은 크므로(수백 KB) 동적 import로 지연 로딩한다 —
// mermaid 블록이 있는 노트를 열 때만 로드된다.

export const MERMAID_LANGUAGE = "mermaid";

export function isMermaidLanguage(language: unknown): boolean {
  return typeof language === "string" && language.toLowerCase() === MERMAID_LANGUAGE;
}

// AI 산출물 등 신뢰할 수 없는 다이어그램 소스를 다루므로 strict 보안 수준 사용
// (mermaid가 SVG를 직접 정화: <script>·이벤트 핸들러·click 인터랙션 차단).
const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "default",
  fontFamily:
    '-apple-system, "Pretendard", "Noto Sans KR", sans-serif',
};

let loader: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!loader) {
    loader = import("mermaid").then((mod) => {
      mod.default.initialize(MERMAID_CONFIG);
      return mod.default;
    });
  }
  return loader;
}

let counter = 0;

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

/**
 * mermaid 소스를 SVG 문자열로 렌더링한다. 실패해도 throw하지 않고
 * 오류 메시지를 반환해 NodeView가 폴백 UI를 그릴 수 있게 한다.
 */
export async function renderMermaid(source: string): Promise<MermaidRenderResult> {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, error: "empty diagram" };
  try {
    const mermaid = await loadMermaid();
    // 빈/문법오류는 parse가 먼저 잡아 깔끔한 메시지를 준다
    await mermaid.parse(trimmed);
    const id = `synapse-mermaid-${counter++}`;
    const { svg } = await mermaid.render(id, trimmed);
    return { ok: true, svg };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
