import { useMemo } from "react";
import { diffLines } from "./diff";

/**
 * 두 텍스트를 줄 단위 diff로 나란히(side-by-side) 보여주는 재사용 컴포넌트.
 * 추가(오른쪽 전용)는 초록, 삭제(왼쪽 전용)는 빨강으로 강조한다.
 * 충돌 해결(FR-4.5)뿐 아니라 파일 히스토리 비교 등에도 쓸 수 있다.
 *
 * diff 계산은 순수 함수 diffLines로 분리돼 단위 테스트된다 (./diff.test.ts).
 */
export function DiffView({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  /** 왼쪽(기준/mine) 텍스트 */
  left: string;
  /** 오른쪽(상대/theirs) 텍스트 */
  right: string;
  leftLabel: string;
  rightLabel: string;
}) {
  const { rows, added, removed } = useMemo(() => diffLines(left, right), [left, right]);

  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="diff-col-label removed-label">{leftLabel}</span>
        <span className="diff-col-label added-label">{rightLabel}</span>
      </div>
      <div className="diff-body" role="table">
        {rows.map((row, i) => (
          <div key={i} className={`diff-row diff-${row.op}`} role="row">
            <span className="diff-gutter">{row.leftNo ?? ""}</span>
            <span className="diff-sign">
              {row.op === "remove" ? "−" : row.op === "add" ? "" : ""}
            </span>
            <span className="diff-text diff-left">
              {row.op === "add" ? "" : row.text}
            </span>
            <span className="diff-gutter">{row.rightNo ?? ""}</span>
            <span className="diff-sign">{row.op === "add" ? "+" : ""}</span>
            <span className="diff-text diff-right">
              {row.op === "remove" ? "" : row.text}
            </span>
          </div>
        ))}
      </div>
      <div className="diff-summary">
        <span className="diff-added-count">+{added}</span>{" "}
        <span className="diff-removed-count">−{removed}</span>
      </div>
    </div>
  );
}
