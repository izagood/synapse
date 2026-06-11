// PLAN-v0.4 Phase 2: 에이전트에 워크스페이스 컨텍스트를 안전하게(읽기 전용)
// 덧붙이는 순수 로직. 파일 내용을 욱여넣지 않고 "경로만" 알려주면 claude가
// 자신의 Read 도구로 직접 읽는다 — 더 간결하고 안전하다.

export interface AgentContextInput {
  /** 워크스페이스 루트 절대 경로 */
  root: string | null;
  /** 현재 활성 노트의 절대 경로 (없으면 null) */
  activePath: string | null;
  /** 열린 탭의 절대 경로 목록 */
  openPaths: string[];
}

/** 루트 기준 상대 경로로 바꾼다. 루트 밖이면 절대 경로를 그대로 둔다. */
export function toRelativePath(root: string, path: string): string {
  if (path === root) return ".";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * 사용자 프롬프트 앞에 붙일 컨텍스트 블록을 만든다.
 * 첨부할 게 없으면 빈 문자열을 돌려준다 (프롬프트가 그대로 전달됨).
 */
export function buildContextBlock(input: AgentContextInput): string {
  const { root, activePath, openPaths } = input;
  if (!root) return "";

  // 중복 제거 + 안정적 순서 유지
  const seen = new Set<string>();
  const rels: string[] = [];
  for (const p of openPaths) {
    const rel = toRelativePath(root, p);
    if (!seen.has(rel)) {
      seen.add(rel);
      rels.push(rel);
    }
  }
  if (rels.length === 0) return "";

  const activeRel = activePath ? toRelativePath(root, activePath) : null;
  const lines: string[] = [];

  if (activeRel) {
    lines.push(`현재 보고 있는 노트: ${activeRel}`);
  }
  // 여러 탭이 열려 있으면 활성 노트 외의 목록도 알려준다.
  const others = rels.filter((r) => r !== activeRel);
  if (others.length > 0) {
    const label = activeRel ? "그 외 열린 노트" : "열린 노트";
    lines.push(`${label}: ${others.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * 컨텍스트 블록과 사용자 프롬프트를 합쳐 실제 CLI에 보낼 프롬프트를 만든다.
 * 컨텍스트가 없으면 프롬프트를 그대로 돌려준다 (회귀 방지).
 */
export function buildAgentPrompt(prompt: string, input: AgentContextInput): string {
  const block = buildContextBlock(input);
  if (!block) return prompt;
  return `[워크스페이스 컨텍스트 — 필요하면 Read 도구로 직접 읽으세요]\n${block}\n\n${prompt}`;
}
