// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { hasRoundtripContentLoss } from "./roundtripSafety";

// 무결성 감사 T6(침묵 소실 차단)의 회귀 픽스처.
// 각 감지 승격에는 반드시 "정상 문서는 잠기지 않는다" 반대 방향 단언을 함께 둔다 —
// lossy lock의 오탐은 문서 잠금(위지윅 읽기 전용)이기 때문이다.

function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

describe("M15: soft break 보존", () => {
  it("문단 안 줄바꿈이 바이트 그대로 왕복되고 잠기지 않는다", () => {
    const src = "첫 줄 문장.\n둘째 줄 문장.\n\n다음 문단.";
    const out = roundtrip(src);
    expect(out.trim()).toBe(src);
    expect(hasRoundtripContentLoss(src, out)).toBe(false);
  });

  it("hard break(백슬래시·2칸) 문서가 잠기지 않는다 — 개행으로 정규화 허용", () => {
    // breaks:true 전환으로 명시적 hard break는 평문 개행으로 정규화된다.
    // synapse 렌더링은 동일하고(모든 개행 = 줄바꿈), 미편집 블록은
    // preserveFormatting이 원본 바이트를 복원하므로 잠글 사유가 아니다.
    for (const src of ["첫 줄\\\n둘째 줄", "첫 줄  \n둘째 줄"]) {
      const out = roundtrip(src);
      expect(hasRoundtripContentLoss(src, out)).toBe(false);
    }
  });
});

describe("H5: reference 정의 소실 감지", () => {
  it("정의 줄이 사라지면 잠긴다", () => {
    const src = "[본문][ref] 링크.\n\n[ref]: https://example.com";
    const out = roundtrip(src);
    // 현 직렬화기는 정의를 인라인으로 해소하고 정의 줄을 삭제한다 → 감지돼야 한다
    expect(hasRoundtripContentLoss(src, out)).toBe(true);
  });

  it("정의가 없는 정상 문서는 잠기지 않는다", () => {
    const src = "# 제목\n\n[일반 링크](https://example.com) 와 본문.";
    expect(hasRoundtripContentLoss(src, roundtrip(src))).toBe(false);
  });
});

describe("H4: 표 셀 안 raw 위키링크 감지", () => {
  it("표 안 [[a|b]] 는 열 절단 손상이므로 잠긴다", () => {
    const src = "| 링크 | 값 |\n| --- | --- |\n| [[노트|별칭]] | 1 |";
    const out = roundtrip(src);
    expect(hasRoundtripContentLoss(src, out)).toBe(true);
  });

  it("표 밖 별칭 위키링크는 보존되고 잠기지 않는다", () => {
    const src = "본문 [[노트|별칭]] 링크.";
    const out = roundtrip(src);
    expect(out).toContain("[[노트|별칭]]");
    expect(hasRoundtripContentLoss(src, out)).toBe(false);
  });

  it("파이프 없는 표 안 위키링크는 잠기지 않는다", () => {
    const src = "| 링크 |\n| --- |\n| [[노트]] |";
    const out = roundtrip(src);
    expect(hasRoundtripContentLoss(src, out)).toBe(false);
  });
});

describe("M11: 각주 이스케이프 감지", () => {
  it("각주가 \\[^1\\] 로 이스케이프되면 잠긴다", () => {
    const src = "본문[^1] 이다.\n\n[^1]: 각주 내용";
    const out = roundtrip(src);
    expect(hasRoundtripContentLoss(src, out)).toBe(true);
  });

  it("각주 없는 정상 문서는 잠기지 않는다", () => {
    const src = "# 제목\n\n본문 **굵게** 와 `코드`.";
    expect(hasRoundtripContentLoss(src, roundtrip(src))).toBe(false);
  });
});
