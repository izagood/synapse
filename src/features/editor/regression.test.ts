// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { preserveFormatting } from "./preserveFormatting";

// 실제로 손상됐던 사용자 노트에서 뽑은 회귀 픽스처.
//
// 사고 경위: 이 문서를 에디터에서 열어둔 채로 두자 sync 타이머가
// 저장을 강제(syncNow → flushDirty)했고, 재직렬화 결과가 디스크를 덮었다.
// 사용자가 편집하지 않은 부분까지 바뀌었다:
//   [[f7-weakness]]  →  \[\[f7-weakness\]\]     위키링크 파괴 (백링크 끊김)
//   <슬러그>          →  &lt;슬러그&gt;          HTML 엔티티
//   문단 안 줄바꿈    →  한 줄로 병합
//
// 여기 있는 구문은 전부 그때 실제로 깨진 것들이다. 하나라도 실패하면
// 같은 사고가 재현된다는 뜻이므로, 단언을 완화하지 말고 원인을 고칠 것.
const FIXTURE = [
  "# 잉글런드 갬빗",
  "",
  "**1.d4 e5** — 티어 7. 레퍼토리가 아니라 **대응법**을 적습니다.",
  "",
  "## 기물 순서",
  "",
  "첫째 줄 문장.",
  "둘째 줄 문장.",
  "",
  "| 수 | 백의 수 | 문제 |",
  "| --- | --- | --- |",
  "| 5 | `5.Bd2?` | 비숍을 되돌림 |",
  "| 6 | `6.Bc3??` | 진짜 패착 |",
  "",
  "구조 파일은 `structures/<슬러그>/README.md` 규약을 따른다.",
  "",
  // 코드 스팬 **밖**의 각도 괄호 — 인라인 코드 안은 이스케이프되지 않으므로
  // 백틱 없는 형태로도 반드시 확인해야 실제 손상을 잡는다.
  "# <구조 이름>",
  "",
  "- [ ] 백의 플랜 한 문장",
  "- [x] 흑의 플랜 한 문장",
  "",
  "## 관련",
  "",
  "- [[f7-weakness]] — 핀처럼 보이는 것이 진짜 핀인가",
  "- [[development-order]] — 나이트 → 비숍 → 캐슬링",
  "",
].join("\n");

function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

describe("실제 손상 사례 회귀", () => {
  it("편집이 없으면 원본과 바이트 동일하게 보존된다", () => {
    // 사고의 본질: 사용자가 아무것도 안 했는데 파일이 바뀌었다.
    const ro = roundtrip(FIXTURE);
    expect(preserveFormatting(FIXTURE, ro, ro)).toBe(FIXTURE);
  });

  it("라운드트립이 멱등이다", () => {
    const once = roundtrip(FIXTURE);
    expect(roundtrip(once)).toBe(once);
  });

  const MUST_SURVIVE: [string, string][] = [
    ["위키링크", "[[f7-weakness]]"],
    ["위키링크(하이픈)", "[[development-order]]"],
    ["각도 괄호(코드 스팬 안)", "<슬러그>"],
    ["각도 괄호(평문)", "# <구조 이름>"],
    ["표 안 인라인 코드", "`6.Bc3??`"],
    ["볼드", "**대응법**"],
  ];

  for (const [name, fragment] of MUST_SURVIVE) {
    it(`${name} 이 그대로 살아남는다: ${fragment}`, () => {
      expect(roundtrip(FIXTURE)).toContain(fragment);
    });
  }

  const MUST_NOT_APPEAR: [string, string][] = [
    ["이스케이프된 위키링크", "\\[\\["],
    ["HTML 엔티티(<)", "&lt;"],
    ["HTML 엔티티(>)", "&gt;"],
  ];

  for (const [name, fragment] of MUST_NOT_APPEAR) {
    it(`${name} 이 나타나지 않는다: ${fragment}`, () => {
      expect(roundtrip(FIXTURE)).not.toContain(fragment);
    });
  }

  it("한 블록만 편집하면 나머지 블록은 바이트 동일하게 남는다", () => {
    // "편집한 곳만 바뀐다"가 이 기능의 핵심 계약이다.
    const ro = roundtrip(FIXTURE);
    const edited = ro.replace("# 잉글런드 갬빗", "# 잉글런드 갬빗 (수정)");
    const result = preserveFormatting(FIXTURE, ro, edited);

    expect(result).toContain("# 잉글런드 갬빗 (수정)");
    // 손대지 않은 블록들은 원본 바이트 그대로여야 한다
    expect(result).toContain("[[f7-weakness]]");
    expect(result).toContain("<슬러그>");
    expect(result).toContain("첫째 줄 문장.\n둘째 줄 문장.");
    expect(result).not.toContain("\\[\\[");
    expect(result).not.toContain("&lt;");
  });

  it("체크리스트가 loose 목록으로 벌어지지 않는다", () => {
    const out = roundtrip(FIXTURE);
    expect(out).toContain("- [ ] 백의 플랜 한 문장\n- [x] 흑의 플랜 한 문장");
  });
});
