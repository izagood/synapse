import { describe, expect, it } from "vitest";
import {
  buildAskNotesPrompt,
  buildRagContextBlock,
  sourceNotesFrom,
} from "./askNotes";
import type { RetrievalResult } from "../ipc/types";

const ROOT = "/home/me/notes";

const result: RetrievalResult = {
  keywords: ["rust", "async"],
  snippets: [
    {
      path: `${ROOT}/rust/async.md`,
      name: "async.md",
      snippet: "tokio 런타임 설명\n비동기 작업",
      directMatch: true,
      score: 23,
    },
    {
      path: `${ROOT}/index.md`,
      name: "index.md",
      snippet: "",
      directMatch: false,
      score: 0,
    },
  ],
};

const empty: RetrievalResult = { keywords: [], snippets: [] };

describe("sourceNotesFrom", () => {
  it("출처 노트를 상대 경로와 함께 점수순으로 뽑는다", () => {
    const sources = sourceNotesFrom(ROOT, result);
    expect(sources).toEqual([
      {
        path: `${ROOT}/rust/async.md`,
        name: "async.md",
        relPath: "rust/async.md",
        directMatch: true,
      },
      {
        path: `${ROOT}/index.md`,
        name: "index.md",
        relPath: "index.md",
        directMatch: false,
      },
    ]);
  });

  it("결과가 없으면 빈 배열", () => {
    expect(sourceNotesFrom(ROOT, empty)).toEqual([]);
  });
});

describe("buildRagContextBlock", () => {
  it("각 스니펫을 '출처: 상대경로' 라벨로 묶는다", () => {
    const block = buildRagContextBlock(ROOT, result, "ko");
    expect(block).toContain("[출처: rust/async.md]");
    expect(block).toContain("tokio 런타임 설명");
    // 본문 없는 보강 노트도 출처 라벨만 남는다
    expect(block).toContain("[출처: index.md]");
  });

  it("관련 노트가 없으면 빈 문자열", () => {
    expect(buildRagContextBlock(ROOT, empty, "ko")).toBe("");
  });

  it("영어 모드면 Source 라벨을 쓴다", () => {
    const block = buildRagContextBlock(ROOT, result, "en");
    expect(block).toContain("[Source: rust/async.md]");
    expect(block).not.toContain("[출처:");
  });
});

describe("buildAskNotesPrompt", () => {
  it("컨텍스트 + 질문을 합친다", () => {
    const out = buildAskNotesPrompt("러스트 async 어떻게 써?", ROOT, result, "ko");
    expect(out).toContain("[출처: rust/async.md]");
    expect(out).toContain("질문: 러스트 async 어떻게 써?");
    // 출처 블록이 질문보다 앞에 온다
    expect(out.indexOf("[출처: rust/async.md]")).toBeLessThan(
      out.indexOf("질문:"),
    );
  });

  it("관련 노트가 없으면 질문을 그대로 둔다 (회귀 방지)", () => {
    expect(buildAskNotesPrompt("아무거나", ROOT, empty, "ko")).toBe("아무거나");
  });

  it("영어 모드면 Question 라벨과 영어 헤더를 쓴다", () => {
    const out = buildAskNotesPrompt("how to use async?", ROOT, result, "en");
    expect(out).toContain("[Source: rust/async.md]");
    expect(out).toContain("Question: how to use async?");
    expect(out).not.toContain("질문:");
  });
});
