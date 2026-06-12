import { describe, expect, it } from "vitest";
import {
  buildAgentPrompt,
  buildContextBlock,
  toRelativePath,
} from "./agentContext";

const ROOT = "/home/me/notes";

describe("toRelativePath", () => {
  it("루트 내부 경로는 상대 경로로 바꾼다", () => {
    expect(toRelativePath(ROOT, `${ROOT}/a/b.md`)).toBe("a/b.md");
  });

  it("루트 자신은 '.'", () => {
    expect(toRelativePath(ROOT, ROOT)).toBe(".");
  });

  it("트레일링 슬래시가 있는 루트도 처리한다", () => {
    expect(toRelativePath(`${ROOT}/`, `${ROOT}/a.md`)).toBe("a.md");
  });

  it("루트 밖 경로는 절대 경로 그대로", () => {
    expect(toRelativePath(ROOT, "/etc/passwd")).toBe("/etc/passwd");
  });

  it("이름이 루트로 시작하지만 다른 폴더면 그대로 둔다", () => {
    expect(toRelativePath(ROOT, "/home/me/notes-backup/a.md")).toBe(
      "/home/me/notes-backup/a.md",
    );
  });
});

describe("buildContextBlock", () => {
  it("root가 없으면 빈 문자열", () => {
    expect(buildContextBlock({ root: null, activePath: null, openPaths: [] }, "ko")).toBe("");
  });

  it("열린 탭이 없으면 빈 문자열", () => {
    expect(buildContextBlock({ root: ROOT, activePath: null, openPaths: [] }, "ko")).toBe("");
  });

  it("활성 노트만 있으면 한 줄", () => {
    const block = buildContextBlock(
      {
        root: ROOT,
        activePath: `${ROOT}/today.md`,
        openPaths: [`${ROOT}/today.md`],
      },
      "ko",
    );
    expect(block).toBe("현재 보고 있는 노트: today.md");
  });

  it("활성 노트 + 다른 탭들을 함께 표기한다", () => {
    const block = buildContextBlock(
      {
        root: ROOT,
        activePath: `${ROOT}/a.md`,
        openPaths: [`${ROOT}/a.md`, `${ROOT}/sub/b.md`, `${ROOT}/c.md`],
      },
      "ko",
    );
    expect(block).toBe(
      "현재 보고 있는 노트: a.md\n그 외 열린 노트: sub/b.md, c.md",
    );
  });

  it("활성 노트가 없으면 '열린 노트' 라벨을 쓴다", () => {
    const block = buildContextBlock(
      {
        root: ROOT,
        activePath: null,
        openPaths: [`${ROOT}/a.md`, `${ROOT}/b.md`],
      },
      "ko",
    );
    expect(block).toBe("열린 노트: a.md, b.md");
  });

  it("중복 경로는 한 번만 표기한다", () => {
    const block = buildContextBlock(
      {
        root: ROOT,
        activePath: `${ROOT}/a.md`,
        openPaths: [`${ROOT}/a.md`, `${ROOT}/a.md`],
      },
      "ko",
    );
    expect(block).toBe("현재 보고 있는 노트: a.md");
  });

  it("영어 모드면 라벨이 영어로 나온다", () => {
    const block = buildContextBlock(
      {
        root: ROOT,
        activePath: `${ROOT}/a.md`,
        openPaths: [`${ROOT}/a.md`, `${ROOT}/b.md`],
      },
      "en",
    );
    expect(block).toBe("Current note: a.md\nOther open notes: b.md");
  });
});

describe("buildAgentPrompt", () => {
  it("컨텍스트가 없으면 프롬프트를 그대로 둔다 (회귀 방지)", () => {
    expect(
      buildAgentPrompt("안녕", { root: null, activePath: null, openPaths: [] }, "ko"),
    ).toBe("안녕");
  });

  it("컨텍스트가 있으면 프롬프트 앞에 블록을 덧붙인다", () => {
    const out = buildAgentPrompt(
      "이 노트 요약해줘",
      {
        root: ROOT,
        activePath: `${ROOT}/today.md`,
        openPaths: [`${ROOT}/today.md`],
      },
      "ko",
    );
    expect(out).toContain("현재 보고 있는 노트: today.md");
    expect(out.endsWith("이 노트 요약해줘")).toBe(true);
    // 원본 프롬프트는 변형되지 않는다
    expect(out).toMatch(/이 노트 요약해줘$/);
  });

  it("영어 모드면 헤더와 라벨이 영어로 나온다", () => {
    const out = buildAgentPrompt(
      "summarize",
      {
        root: ROOT,
        activePath: `${ROOT}/today.md`,
        openPaths: [`${ROOT}/today.md`],
      },
      "en",
    );
    expect(out).toContain("Workspace context");
    expect(out).toContain("Current note: today.md");
    expect(out).not.toContain("현재 보고 있는 노트");
    expect(out.endsWith("summarize")).toBe(true);
  });
});
