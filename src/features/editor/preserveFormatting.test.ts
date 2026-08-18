// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { preserveFormatting } from "./preserveFormatting";

// 에디터를 한 바퀴 돌려(정규화 직렬화) 결과를 만든다 — 실제 저장 경로와 동일.
function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

// 표·틸드·soft break·인접 이탤릭이 모두 섞여 tiptap 직렬화가 변형하는 문서.
const DOC = [
  "# 제목",
  "",
  "| 항목 | 값 |",
  "|------|------|",
  "| `nn.cc` | ~3,500+ |",
  "",
  "첫째 줄 문장.",
  "둘째 줄 문장.",
  "",
  "*분석 일자: 2026-04-10*",
  "*대상 브랜치: dev (668e983fb7)*",
  "",
].join("\n");

describe("preserveFormatting", () => {
  it("편집이 없으면 원본과 바이트 동일하게 보존한다", () => {
    const ro = roundtrip(DOC);
    // 직렬화기가 실제로 변형을 일으켰음을 먼저 확인(테스트 전제).
    expect(ro).not.toBe(DOC);
    // serialized === roundtripped(편집 없음) → 원본 바이트로 복원.
    expect(preserveFormatting(DOC, ro, ro)).toBe(DOC);
  });

  it("한 블록만 편집하면 나머지 블록은 원본 바이트를 유지한다", () => {
    const ro = roundtrip(DOC);
    // 사용자가 제목만 고친 상황을 재현: RO에서 제목 줄만 바꾼다.
    const edited = ro.replace("# 제목", "# 제목 수정됨");
    const result = preserveFormatting(DOC, ro, edited);

    // 편집한 제목은 반영되고,
    expect(result).toContain("# 제목 수정됨");
    // 손대지 않은 블록들은 원본 바이트 그대로 — 정규화가 새지 않는다.
    expect(result).toContain("|------|------|"); // 표 구분선 원형
    expect(result).toContain("~3,500+"); // 틸드 이스케이프 안 됨
    expect(result).toContain("첫째 줄 문장.\n둘째 줄 문장."); // soft break 보존
    expect(result).toContain("*분석 일자: 2026-04-10*\n*대상 브랜치: dev (668e983fb7)*");
  });

  it("한 블록 편집 시 그 블록 외에는 정확히 원본 바이트여야 한다", () => {
    const ro = roundtrip(DOC);
    const edited = ro.replace("# 제목", "# 제목 수정됨");
    const result = preserveFormatting(DOC, ro, edited);
    // 제목 줄만 바뀌고 그 외 전부 원본과 바이트 동일.
    expect(result).toBe(DOC.replace("# 제목", "# 제목 수정됨"));
  });

  it("블록을 삭제해도 남은 블록은 원본 바이트를 유지한다", () => {
    const ro = roundtrip(DOC);
    // 표 블록을 통째로 삭제한 편집(RO 기준 표 세 줄 제거).
    const edited = ro
      .split("\n")
      .filter((l) => !l.includes("|"))
      .join("\n");
    const result = preserveFormatting(DOC, ro, edited);

    expect(result).not.toContain("| 항목 | 값 |");
    // 남은 블록은 원본 바이트 그대로.
    expect(result).toContain("첫째 줄 문장.\n둘째 줄 문장.");
    expect(result).toContain("*분석 일자: 2026-04-10*\n*대상 브랜치: dev (668e983fb7)*");
  });

  it("블록을 삽입해도 기존 블록은 원본 바이트를 유지한다", () => {
    const ro = roundtrip(DOC);
    // 문서 끝에 새 문단을 하나 추가한 편집.
    const edited = ro.replace(/\n*$/, "") + "\n\n새로 추가한 문단.\n";
    const result = preserveFormatting(DOC, ro, edited);

    expect(result).toContain("새로 추가한 문단.");
    expect(result).toContain("|------|------|");
    expect(result).toContain("첫째 줄 문장.\n둘째 줄 문장.");
    expect(result).toContain("*분석 일자: 2026-04-10*\n*대상 브랜치: dev (668e983fb7)*");
  });
  // 저장 경로 회귀: 1이 아닌 숫자로 시작하는 순서 목록이 결과에 들어오면
  // blockSignatures가 던지면서 onUpdate가 중단되고 저장이 조용히 멈췄다.
  it("1이 아닌 숫자로 시작하는 순서 목록이 있어도 저장 경로가 살아있다", () => {
    const original = "# 제목\n";
    const ro = roundtrip(original);
    const edited = ro.replace(/\n*$/, "") + "\n\n2. 둘째 항목\n\n3. 셋째 항목\n";

    expect(() => preserveFormatting(original, ro, edited)).not.toThrow();
    const result = preserveFormatting(original, ro, edited);
    expect(result).toContain("2. 둘째 항목");
    expect(result).toContain("3. 셋째 항목");
    expect(result).toContain("# 제목");
  });
  // 정렬 로직이 실패해도 저장은 계속돼야 한다. 예외가 호출부로 새면
  // onUpdate가 중단되어 자동 저장이 조용히 멈춘다.
  it("정렬이 실패해도 예외 대신 재직렬화 결과로 폴백한다", () => {
    // 서로게이트 페어가 쪼개진 문자열 등 어떤 입력이 와도 던지지 않는다.
    const weird = "\uD800 깨진 서로게이트\n\n2. 둘째\n";
    expect(() => preserveFormatting("# 제목\n", "# 제목", weird)).not.toThrow();
    expect(preserveFormatting("# 제목\n", "# 제목", weird)).toContain("둘째");
  });
});
