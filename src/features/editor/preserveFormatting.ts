import { blockSignatures } from "./roundtripSafety";

// tiptap 재직렬화(serialized)는 사용자가 건드리지 않은 블록까지 정규화한다
// (표 구분선, 틸드 이스케이프, soft break 병합 등). 이 모듈은 편집 없이도
// 정규화되는 이 변형을 되돌린다.
//
// 핵심 아이디어: "블록을 편집하지 않았다" ⟺ "그 블록의 재직렬화 형태가
// serialized 안에 그대로 있다". 그래서 원본 O 와 함께 O 의 재직렬화본
// RO(=로드 직후 getMarkdown 결과, 호출부의 baseline)를 받아,
// RO 블록 ↔ serialized 블록을 텍스트로 정렬한다. 매칭된(=편집 안 된) 블록은
// 대응하는 O 원본 바이트를, 매칭 안 된(편집·신규) 블록은 serialized 바이트를 쓴다.
//
// 불변식: serialized 가 RO 와 같으면(=실제 편집 없음) 결과는 O 와 바이트 동일.

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

// lineOffsets[k] = k번째 라인이 시작하는 문자 인덱스. split("\n") 기준.
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

type Block = { startLine: number; endLine: number };

// 블록의 내용 텍스트 — 정렬 매칭 키로 쓴다. 말미 개행은 정규화해서
// "마지막 블록 vs 중간 블록"의 최종 개행 유무 차이로 매칭이 깨지지 않게 한다.
function blockContent(text: string, off: number[], b: Block): string {
  return text.slice(off[b.startLine], off[b.endLine] ?? text.length).replace(/\n+$/, "");
}

// 블록의 전체 세그먼트(뒤따르는 빈 줄 포함) — 출력에 쓴다. 세그먼트들을
// 이어붙이면 원본이 복원되도록 다음 블록 시작 직전까지 슬라이스한다.
function blockSegment(text: string, off: number[], blocks: Block[], i: number): string {
  const from = off[blocks[i].startLine];
  const to = i + 1 < blocks.length ? off[blocks[i + 1].startLine] : text.length;
  return text.slice(from, to);
}

// a[i]가 b[j]와 매칭되는 최장 공통 부분수열을 구해, b의 각 인덱스에 대해
// 매칭된 a 인덱스(없으면 -1)를 돌려준다. 순서 보존·1:1.
function lcsMatch(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchForB = new Array(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matchForB[j] = i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matchForB;
}

/**
 * 원본 포맷을 최대한 보존한 본문을 만든다.
 *
 * @param original    디스크의 원본 본문 O (보존 대상 바이트).
 * @param roundtripped O 를 에디터에 한 번 통과시킨 재직렬화본 RO
 *                     (로드 직후 baseline). "편집 안 됨"의 기준.
 * @param serialized   현재 편집 상태의 재직렬화본 N (저장하려는 내용).
 */
export function preserveFormatting(
  original: string,
  roundtripped: string,
  serialized: string,
): string {
  const O = normalizeLineEndings(original);
  const RO = normalizeLineEndings(roundtripped);
  const N = normalizeLineEndings(serialized);
  if (RO === N) return original; // 편집 없음 → 원본 바이트 그대로

  const oB = blockSignatures(O);
  const roB = blockSignatures(RO);
  const nB = blockSignatures(N);
  // O 와 RO 의 블록이 1:1 로 대응하지 않으면(드묾) 안전하게 재직렬화 결과를 쓴다.
  if (oB.length === 0 || oB.length !== roB.length || nB.length === 0) return serialized;

  const oOff = lineOffsets(O);
  const roOff = lineOffsets(RO);
  const nOff = lineOffsets(N);

  const matchForN = lcsMatch(
    roB.map((b) => blockContent(RO, roOff, b)),
    nB.map((b) => blockContent(N, nOff, b)),
  );

  // 첫 블록 앞의 선행 텍스트(선행 빈 줄 등)는 원본 것을 유지.
  let out = O.slice(0, oOff[oB[0].startLine]);
  for (let j = 0; j < nB.length; j++) {
    const oi = matchForN[j]; // RO 인덱스 == O 인덱스 (1:1 대응)
    out += oi >= 0 ? blockSegment(O, oOff, oB, oi) : blockSegment(N, nOff, nB, j);
  }
  return out;
}
