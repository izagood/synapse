// 2-C "내 노트에게 묻기" (RAG, 검색 기반 v1):
// retrieval 결과(관련 노트 스니펫)를 "출처: 파일경로" 라벨과 함께 컨텍스트로
// 묶어 에이전트 프롬프트에 주입하고, 답변에 쓰인 출처 노트 목록을 뽑는 순수 로직.
//
// 임베딩이 아닌 키워드 매칭 기반 retrieval이며, 실제 검색은 synapse-core
// retrieval::retrieve_context(Rust)가 한다. 여기서는 그 결과를 프롬프트로
// 조립하고 UI 표시용 출처 목록을 정리하기만 한다(테스트 가능한 순수 함수).

import type { RetrievalResult, RetrievedSnippet } from "../ipc/types";
import { toRelativePath } from "./agentContext";

/** UI에 표시·클릭할 출처 노트 한 건. */
export interface SourceNote {
  /** 절대 경로 (클릭 시 openFileAt에 넘김) */
  path: string;
  /** 파일명 (표시용) */
  name: string;
  /** 루트 기준 상대 경로 (표시용) */
  relPath: string;
  /** 직접 검색 매칭인지 (false면 백링크로 보강된 인접 노트) */
  directMatch: boolean;
}

/**
 * retrieval 결과에서 UI 표시용 출처 노트 목록을 만든다.
 * retrieval은 이미 점수순으로 정렬되어 있으므로 순서를 보존한다.
 */
export function sourceNotesFrom(
  root: string,
  result: RetrievalResult,
): SourceNote[] {
  return result.snippets.map((s) => ({
    path: s.path,
    name: s.name,
    relPath: toRelativePath(root, s.path),
    directMatch: s.directMatch,
  }));
}

/** 스니펫 하나를 "출처: 상대경로" 라벨 + 본문으로 포맷한다. */
function formatSnippet(root: string, snippet: RetrievedSnippet): string {
  const rel = toRelativePath(root, snippet.path);
  const body = snippet.snippet.trim();
  // 본문이 비어 있는(백링크 보강) 노트도 출처로는 남겨 둔다 — claude가 직접 읽도록.
  return body ? `[출처: ${rel}]\n${body}` : `[출처: ${rel}]`;
}

/**
 * retrieval 결과를 에이전트 프롬프트에 주입할 컨텍스트 블록으로 만든다.
 * 관련 노트가 없으면 빈 문자열을 돌려준다.
 */
export function buildRagContextBlock(
  root: string,
  result: RetrievalResult,
): string {
  if (result.snippets.length === 0) return "";
  const parts = result.snippets.map((s) => formatSnippet(root, s));
  return parts.join("\n\n");
}

/**
 * 질문 + retrieval 컨텍스트를 합쳐 CLI에 보낼 프롬프트를 만든다.
 * 관련 노트가 없으면 질문을 그대로 돌려준다(회귀 방지). claude가 추가로 필요한
 * 노트를 Read 도구로 직접 읽을 수 있도록 경로(출처)를 함께 준다.
 */
export function buildAskNotesPrompt(
  question: string,
  root: string,
  result: RetrievalResult,
): string {
  const block = buildRagContextBlock(root, result);
  if (!block) return question;
  return [
    "[내 노트에서 찾은 관련 발췌 — 답변의 근거로 삼고, 사용한 노트의 경로를 인용하세요.",
    "더 필요하면 Read 도구로 해당 경로를 직접 읽으세요.]",
    "",
    block,
    "",
    `질문: ${question}`,
  ].join("\n");
}
