// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions, getMarkdown } from "./extensions";
import { hasRoundtripContentLoss } from "./roundtripSafety";
import { preserveFormatting, takeLastPreserveFallback } from "./preserveFormatting";

function roundtrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ withPlaceholder: false }),
    content: markdown,
  });
  const out = getMarkdown(editor);
  editor.destroy();
  return out;
}

describe("변환 손실 감지", () => {
  it("표현 불가능한 입력(볼드로 감싼 인라인 코드)을 손실로 감지한다", () => {
    // `code` 마크는 excludes: "_" 라 다른 마크를 배제한다.
    // 즉 **`x`** 는 문서 모델로 표현 자체가 불가능해 파싱 시점에 bold 가 사라진다.
    // 직렬화로는 고칠 수 없는 종류이므로 저장을 막아야 하는 대표 케이스다.
    const src = "| 수 | 값 |\n| --- | --- |\n| 6 | **`6.Bc3??`** |";
    const ro = roundtrip(src);
    expect(ro).not.toBe(src);
    expect(hasRoundtripContentLoss(src, ro)).toBe(true);
  });

  it("정상 문서는 손실로 판정하지 않는다", () => {
    const src = "# 제목\n\n본문 **굵게** 와 `코드`.\n\n- [[링크]]\n- <슬러그>\n";
    expect(hasRoundtripContentLoss(src, roundtrip(src))).toBe(false);
  });
});

describe("폴백 관측", () => {
  it("블록 수가 어긋나면 사유가 기록된다", () => {
    takeLastPreserveFallback(); // 초기화
    // O 와 RO 의 블록 수가 다르게 만든다 → 문서 전체 보존 포기 경로
    preserveFormatting("# 제목\n\n본문\n", "# 제목\n", "# 제목 수정\n");
    const fallback = takeLastPreserveFallback();
    expect(fallback?.kind).toBe("blockCountMismatch");
  });

  it("예외가 나도 던지지 않고 사유를 기록한다", () => {
    takeLastPreserveFallback();
    // 잘못된 서로게이트는 내부에서 예외를 유발할 수 있다. 어떤 경우든
    // 호출부(onUpdate)로 예외가 새면 자동저장이 죽으므로 절대 던지지 않아야 한다.
    expect(() => preserveFormatting("\uD800", "\uD800", "\uD800 편집")).not.toThrow();
  });

  it("편집이 없으면 폴백 없이 원본 바이트가 그대로 유지된다", () => {
    takeLastPreserveFallback();
    const doc = "# 제목\n\n첫째 줄.\n둘째 줄.\n";
    const ro = roundtrip(doc);
    expect(preserveFormatting(doc, ro, ro)).toBe(doc);
    expect(takeLastPreserveFallback()).toBeNull();
  });
});
