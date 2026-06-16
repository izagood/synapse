// `.excalidraw`(Excalidraw 표준 JSON) 파일을 다루는 순수 헬퍼.
//
// 실제 장면 복원(요소/앱상태 검증·기본값·바인딩 복구·버전 마이그레이션)은 Excalidraw가
// export하는 검증된 `restore()`에 맡긴다. 여기서는 그 앞단의 "이 내용을 Excalidraw에
// 넘겨도 되는가" 판정만 한다 — 무거운 Excalidraw 번들을 불러오지 않으므로 node
// 테스트 환경에서 그대로 검증할 수 있고, ExcalidrawEditor만 패키지를 lazy 로드한다.

/** parseSceneContent 결과: 빈(새) 드로잉 / 파싱된 장면 데이터 / 손상(거부) */
export type ParsedScene =
  | { kind: "empty" }
  | { kind: "scene"; data: Record<string, unknown> };

/** 표준 `.excalidraw` 파일의 source 필드 (다른 도구와의 호환 표식) */
export const EXCALIDRAW_SOURCE = "https://excalidraw.com";

/**
 * `.excalidraw` 파일 내용을 Excalidraw `restore()`에 넘기기 전 단계로 해석한다.
 *
 * - 빈/공백 내용은 빈 장면(새로 만든 드로잉)으로 본다.
 * - JSON이 깨졌거나 Excalidraw 장면이 아니면(`elements` 배열이 없으면) `null`.
 *   호출 측은 null일 때 편집기를 띄우지 않아, 다른 JSON 파일이나 손상된 파일을
 *   빈 장면으로 덮어쓰지 않는다.
 *
 * 요소/앱상태의 실제 정규화는 하지 않는다 — 그 책임은 Excalidraw `restore()`에 있다.
 */
export function parseSceneContent(content: string): ParsedScene | null {
  const trimmed = content.trim();
  if (!trimmed) return { kind: "empty" };

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  // Excalidraw 장면은 elements 배열을 가진다. 없으면 장면 파일로 보지 않는다.
  if (!Array.isArray((data as Record<string, unknown>).elements)) return null;

  return { kind: "scene", data: data as Record<string, unknown> };
}

/** 빈 `.excalidraw` 파일 내용 (새 드로잉 생성용) */
export function emptySceneJson(): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: EXCALIDRAW_SOURCE,
      elements: [],
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    },
    null,
    2,
  );
}
