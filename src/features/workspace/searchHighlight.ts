// 검색 결과 스니펫에서 질의와 일치하는 구간을 강조하기 위한 순수 로직.
// 대소문자 무시로 모든 일치 구간을 찾아 텍스트를 조각으로 나눈다.

export interface SnippetSegment {
  text: string;
  match: boolean;
}

/**
 * `snippet`을 `query`의 (대소문자 무시) 일치 구간 기준으로 쪼갠다.
 * 일치가 없거나 질의가 비어 있으면 전체를 비강조 한 조각으로 돌려준다.
 */
export function highlightSnippet(snippet: string, query: string): SnippetSegment[] {
  const needle = query.trim();
  if (!needle) return [{ text: snippet, match: false }];

  const lowerSnippet = snippet.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: SnippetSegment[] = [];
  let cursor = 0;

  while (cursor < snippet.length) {
    const found = lowerSnippet.indexOf(lowerNeedle, cursor);
    if (found === -1) {
      segments.push({ text: snippet.slice(cursor), match: false });
      break;
    }
    if (found > cursor) {
      segments.push({ text: snippet.slice(cursor, found), match: false });
    }
    segments.push({ text: snippet.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }

  return segments.length > 0 ? segments : [{ text: snippet, match: false }];
}
