// 줄 단위 diff 계산 — UI에 의존하지 않는 순수 함수 (FR-4.5 충돌 diff 뷰).
//
// 외부 diff 라이브러리 없이 표준 LCS(최장 공통 부분수열)로 두 텍스트의 줄을
// 정렬한다. 노트 한 편 분량에는 충분히 빠르고 새 의존성이 필요 없다.
// 파일 히스토리(FR-4.7) 등 다른 곳에서도 재사용할 수 있게 shared에 둔다.

/** 한 줄의 diff 분류. */
export type DiffOp = "equal" | "add" | "remove";

/**
 * side-by-side 렌더링을 위한 한 행.
 * - equal:  양쪽에 같은 줄 (leftNo·rightNo 모두 있음)
 * - remove: 왼쪽(mine)에만 있는 줄 (rightNo=null)
 * - add:    오른쪽(theirs)에만 있는 줄 (leftNo=null)
 */
export interface DiffRow {
  op: DiffOp;
  /** 왼쪽(기준/mine) 줄 번호 (1-based). 없으면 null */
  leftNo: number | null;
  /** 오른쪽(상대/theirs) 줄 번호 (1-based). 없으면 null */
  rightNo: number | null;
  /** 줄 내용 (개행 제외) */
  text: string;
}

/** diff 결과 요약. */
export interface DiffSummary {
  rows: DiffRow[];
  /** 오른쪽에만 있는(추가된) 줄 수 */
  added: number;
  /** 왼쪽에만 있는(삭제된) 줄 수 */
  removed: number;
}

/** 텍스트를 줄 배열로. 끝의 단일 개행은 줄로 세지 않는다 ("a\n" → ["a"]). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * LCS 길이 테이블 (뒤에서부터 채워 역추적이 앞에서 진행되도록 한다).
 * dp[i][j] = left[i..], right[j..]의 최장 공통 부분수열 길이.
 */
function lcsTable(left: string[], right: string[]): number[][] {
  const m = left.length;
  const n = right.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        left[i] === right[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * 두 텍스트(left=mine, right=theirs)를 줄 단위로 비교해 side-by-side 행 목록을
 * 만든다. 변경된 줄은 remove(왼쪽) + add(오른쪽) 조합으로 나타난다.
 */
export function diffLines(left: string, right: string): DiffSummary {
  const a = splitLines(left);
  const b = splitLines(right);
  const dp = lcsTable(a, b);

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ op: "equal", leftNo: i + 1, rightNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 왼쪽 줄을 버리는 편이 (또는 같은) 더 긴 공통 수열로 이어진다 → 삭제
      rows.push({ op: "remove", leftNo: i + 1, rightNo: null, text: a[i] });
      removed++;
      i++;
    } else {
      rows.push({ op: "add", leftNo: null, rightNo: j + 1, text: b[j] });
      added++;
      j++;
    }
  }
  while (i < a.length) {
    rows.push({ op: "remove", leftNo: i + 1, rightNo: null, text: a[i] });
    removed++;
    i++;
  }
  while (j < b.length) {
    rows.push({ op: "add", leftNo: null, rightNo: j + 1, text: b[j] });
    added++;
    j++;
  }
  return { rows, added, removed };
}
