import type { EditPreview } from "../../ipc/types";

// 2-B 안전 편집: 권한 승인 다이얼로그의 순수 로직.
// UI(AgentPanel)와 분리해 vitest로 단위 테스트한다.

export interface PendingPermission {
  requestId: string;
  tool: string;
  detail: string;
  edit: EditPreview | null;
}

/** 한 줄 단위 diff (미리보기 렌더링용) */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

/**
 * 승인 시 어떻게 처리할지 결정한다.
 * - 편집 도구(Edit/Write): CLI 직접 쓰기를 막고(allowCli=false) CRDT 경유로
 *   적용한다(applyEdit=true). 안전 편집의 핵심 — AI 쓰기는 ai-assistant
 *   actor로만 흐른다.
 * - 그 외 도구(Read 등): CLI에 그대로 허용한다(allowCli=true).
 */
export interface ApprovalPlan {
  /** CLI에 회신할 allow 값 (control_response) */
  allowCli: boolean;
  /** agent_edit_file로 CRDT 편집을 적용해야 하는가 */
  applyEdit: boolean;
}

export function planApproval(pending: PendingPermission): ApprovalPlan {
  if (pending.edit) {
    return { allowCli: false, applyEdit: true };
  }
  return { allowCli: true, applyEdit: false };
}

/** 거부는 항상 CLI에 deny를 회신하고 아무것도 적용하지 않는다 */
export function planRejection(): ApprovalPlan {
  return { allowCli: false, applyEdit: false };
}

/**
 * base 텍스트에 편집을 적용해 새 전체 텍스트를 만든다 (synapse-core
 * apply_tool_edit과 동일 의미 — 프론트에서 미리보기·CRDT 입력 생성용).
 * Write는 전체 교체, Edit은 old_string의 유일한 일치를 치환한다.
 * 적용 불가하면 에러 메시지를 던진다.
 */
export function applyEditToBase(base: string, edit: EditPreview): string {
  if (edit.wholeFile) return edit.newString;
  if (edit.oldString === "") {
    throw new Error("빈 old_string은 편집할 수 없습니다");
  }
  const first = base.indexOf(edit.oldString);
  if (first === -1) throw new Error("찾는 내용이 파일에 없습니다");
  const second = base.indexOf(edit.oldString, first + edit.oldString.length);
  if (second !== -1) throw new Error("찾는 내용이 여러 번 나타나 편집이 모호합니다");
  return base.slice(0, first) + edit.newString + base.slice(first + edit.oldString.length);
}

/**
 * 편집 미리보기용 라인 단위 diff. 정밀한 LCS가 아니라, 변경 영역(old→new)을
 * 통째로 삭제/추가 블록으로 보여주는 단순하고 안정적인 방식.
 * Write(wholeFile)는 전체를 추가로 보여준다.
 */
export function previewDiff(edit: EditPreview): DiffLine[] {
  const toLines = (s: string): string[] => (s === "" ? [] : s.split("\n"));
  if (edit.wholeFile) {
    return toLines(edit.newString).map((text) => ({ kind: "add", text }));
  }
  const out: DiffLine[] = [];
  for (const text of toLines(edit.oldString)) out.push({ kind: "del", text });
  for (const text of toLines(edit.newString)) out.push({ kind: "add", text });
  return out;
}

/** 파일 경로에서 표시용 파일명만 뽑는다 */
export function fileLabel(edit: EditPreview): string {
  const parts = edit.filePath.split(/[/\\]/);
  return parts[parts.length - 1] || edit.filePath;
}
