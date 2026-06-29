// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";

// md → 에디터 → md 라운드트립 검증 (NFR-3의 핵심 리스크 가드).
// 포맷은 정규화될 수 있으므로 (1) 한 번 더 돌려도 변하지 않는 안정성과
// (2) 의미 보존(핵심 구문 생존)을 검사한다.
function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

const CASES: Record<string, { input: string; mustContain: string[] }> = {
  headings: {
    input: "# 제목 1\n\n## 제목 2\n\n본문 문단",
    mustContain: ["# 제목 1", "## 제목 2", "본문 문단"],
  },
  emphasis: {
    input: "이건 **굵게** 그리고 *기울임* 그리고 `코드` 그리고 ~~취소선~~",
    mustContain: ["굵게", "기울임", "`코드`", "취소선"],
  },
  lists: {
    input: "- 하나\n- 둘\n  - 둘의 자식\n\n1. 첫째\n2. 둘째",
    mustContain: ["- 하나", "- 둘의 자식", "1. 첫째", "2. 둘째"],
  },
  taskList: {
    input: "- [ ] 미완료 작업\n- [x] 완료된 작업",
    mustContain: ["- [ ] 미완료 작업", "- [x] 완료된 작업"],
  },
  codeBlock: {
    input: '```ts\nconst x: number = 1;\n```',
    mustContain: ["```ts", "const x: number = 1;"],
  },
  // CodeBlockLowlight 도입 후에도 언어 태그와 내용이 보존되어야 한다
  codeBlockRust: {
    input: '```rust\nfn main() {\n    println!("{}", 1 + 1);\n}\n```',
    mustContain: ["```rust", "fn main() {", 'println!("{}", 1 + 1);'],
  },
  // mermaid 블록은 다이어그램으로 렌더링되지만 직렬화는 코드 블록 그대로 보존돼야 한다
  mermaid: {
    input: "```mermaid\ngraph TD\n  A[시작] --> B[끝]\n```",
    mustContain: ["```mermaid", "graph TD", "A[시작] --> B[끝]"],
  },
  blockquoteAndHr: {
    input: "> 인용문입니다\n\n---\n\n다음 문단",
    mustContain: ["> 인용문입니다", "---", "다음 문단"],
  },
  link: {
    input: "[Synapse](https://github.com/izagood/synapse) 링크",
    mustContain: ["[Synapse](https://github.com/izagood/synapse)"],
  },
  // 상대경로 파일 링크 — tiptap 기본 isAllowedUri가 '/'를 포함한 상대경로를
  // 파싱 시점에 버려 평문으로 뭉개지던 회귀(README 동기화 시 표 링크 소실).
  relativeLink: {
    input: "[소유권](advanced/01-ownership-borrowing.md) 링크",
    mustContain: ["[소유권](advanced/01-ownership-borrowing.md)"],
  },
  // 붙여넣기가 기록하는 ASCII 랜덤 파일명 이미지 — 정확히 보존돼야 한다
  image: {
    input: "![diagram](image-mbz3k1-x4f2a.png)",
    mustContain: ["![diagram](image-mbz3k1-x4f2a.png)"],
  },
  // 회귀(2026-06-29 meeting): 외부 머지 적용 경로(setContent)가 다중 섹션 문서를
  // 무손실로 반영해야 한다. 라이브 버퍼 붕괴 시 상단 섹션이 사라졌었다.
  meetingMultiSection: {
    input:
      "# | DevOps Union |\n\n- DevOps Union\n  - <https://app.notion.com/p/x>\n\n" +
      "# | RCNS 인프라 리소스 |\n\n- 인프라 리소스\n  - atom-max\n\n" +
      "# | Cloud Infra |\n\n- [Cloud SDK](https://example.com/sdk)\n\n" +
      "# | Cloud 데일리 |\n\n- [Cloud Jira](https://example.com/jira)",
    mustContain: [
      "# | DevOps Union |",
      "# | RCNS 인프라 리소스 |",
      "# | Cloud Infra |",
      "# | Cloud 데일리 |",
    ],
  },
};

describe("markdown roundtrip (tiptap-markdown)", () => {
  it("preserves tables (가장 치명적이었던 손상 케이스)", () => {
    const table = "| 이름 | 값 |\n| --- | --- |\n| a | 1 |\n| b | 2 |";
    const out = roundtrip(table);
    expect(out).toContain("| 이름 | 값 |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| a | 1 |");
    expect(out).toContain("| b | 2 |");
    expect(roundtrip(out)).toBe(out);
  });

  it("표 셀 안의 상대경로 링크를 보존한다 (README 동기화 회귀 케이스)", () => {
    const table =
      "| 주제 | 문서 |\n| --- | --- |\n| 소유권 | [보기](advanced/01-ownership-borrowing.md) |";
    const out = roundtrip(table);
    expect(out).toContain("[보기](advanced/01-ownership-borrowing.md)");
    expect(roundtrip(out)).toBe(out);
  });

  it("위험 스킴(javascript:)은 활성 링크로 직렬화되지 않는다", () => {
    // isAllowedUri 오버라이드는 '스킴 없는 상대경로'만 허용하고,
    // 스킴이 있으면 tiptap 기본 검증으로 떨어뜨려 위험 스킴을 차단한다.
    const out = roundtrip("[클릭](javascript:alert(1))");
    // 링크 마크가 떨어져 브래킷이 이스케이프된 평문으로 남는다(활성 링크 아님).
    expect(out).not.toContain("[클릭](javascript:");
    expect(out).toContain("\\[클릭\\]");
  });

  it("keeps task lists tight (항목 사이 빈 줄 삽입 금지)", () => {
    const input = "- [ ] 미완료\n- [x] 완료\n- [ ] 셋째";
    expect(roundtrip(input)).toBe(input);
  });

  it("does not alter a typical note exactly (정확 일치)", () => {
    const note = [
      "# | TODO |",
      "",
      "- [Cloud weekly](https://example.com/weekly)",
      "- kv cache",
      "  - Mooncake",
      "",
      "일반 문단 snake_case_name 그리고 | 파이프 | 텍스트",
      "",
      "- [ ] 미완료",
      "- [x] 완료",
    ].join("\n");
    expect(roundtrip(note)).toBe(note);
  });

  it("한글 파일명 이미지는 %인코딩될 수 있지만 같은 파일을 가리킨다", () => {
    // markdown-it은 파싱 시 링크 목적지를 %인코딩한다(normalizeLink).
    // 인코딩된 형태도 유효한 md이고, 표시 경로(displayImageSrc)가 디코드해
    // 디스크의 실제 파일로 복원한다 — 디코드 결과가 원본 파일명과 같아야 한다.
    const name = "스크린샷-2026-06-11-오후-3.24.15.png";
    const once = roundtrip(`![shot](${name})`);
    const dest = once.match(/!\[shot\]\(([^)]+)\)/)?.[1];
    expect(dest).toBeDefined();
    expect(decodeURIComponent(dest!)).toBe(name);
    expect(roundtrip(once)).toBe(once);
  });

  it("공백 포함 이미지 목적지는 파싱되지 않는다 (safeImageName이 필요한 이유)", () => {
    // CommonMark는 ![alt](목적지)의 목적지에 공백을 허용하지 않는다.
    // 이 동작이 바뀌지 않는 한 드롭 시 파일명 공백 치환을 유지해야 한다.
    const out = roundtrip("![shot](스크린샷 2026-06-11 오후 3.24.15.png)");
    expect(out).not.toContain("![shot](스크린샷 2026-06-11");
  });

  for (const [name, { input, mustContain }] of Object.entries(CASES)) {
    it(`${name}: preserves semantics and is idempotent`, () => {
      const once = roundtrip(input);
      for (const fragment of mustContain) {
        expect(once).toContain(fragment);
      }
      // 두 번째 라운드트립에서 더는 변형이 없어야 한다
      expect(roundtrip(once)).toBe(once);
    });
  }
});
