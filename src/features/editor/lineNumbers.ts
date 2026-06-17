// 소스 에디터 줄 번호 거터용 순수 헬퍼.
// VS Code처럼 "화면에 보이는 행 = 논리 줄(개행 기준)"로 번호를 매긴다.
// 워드랩은 끄므로(가로 스크롤) 논리 줄과 시각 행이 1:1로 일치한다.

/** 텍스트의 줄 수 (개행 기준). 빈 문자열도 1줄로 센다. */
export function countLines(content: string): number {
  return content.split("\n").length;
}

/**
 * 캐럿 위치가 속한 줄의 0-기반 인덱스 (현재 줄 하이라이트용).
 * caretPos는 [0, content.length] 범위로 보정한다.
 */
export function activeLineIndex(content: string, caretPos: number): number {
  const end = Math.max(0, Math.min(caretPos, content.length));
  let line = 0;
  for (let i = 0; i < end; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
