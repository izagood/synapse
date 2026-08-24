import { Text } from "@tiptap/extension-text";

// 평문 안의 `<`, `>` 가 저장 시 `&lt;`, `&gt;` 로 바뀌던 문제를 막는다.
//
// 원인은 prosemirror-markdown 의 esc() 가 아니라 tiptap-markdown 쪽이다:
// node_modules/tiptap-markdown/src/extensions/nodes/text.js 가
// `state.text(escapeHTML(node.text))` 로 직렬화하고,
// util/dom.js 의 escapeHTML 이 `<` → `&lt;`, `>` → `&gt;` 를 무조건 적용한다.
//
// 그래서 `# <슬러그>` 같은 템플릿 자리표시자나 `a < b` 같은 부등호가
// 편집하지 않아도 저장만 하면 깨졌다.
//
// 안전성: 위험한 원시 HTML은 **파싱 시점에 이미 제거**된다. 실측하면
//   "<script>alert(1)</script>"  → 문서 모델: 빈 문단 (텍스트 노드 없음)
//   "<슬러그>"                    → 문서 모델: text "<슬러그>"
// 즉 문서 모델에 남은 텍스트의 `<` 는 사용자가 친 리터럴 문자다.
// 이걸 이스케이프하는 것은 보호가 아니라 손상이다. 마크다운은 HTML이 아니므로
// 평문의 `<` 는 그대로 쓰는 것이 옳다.
//
// 마크다운 특수문자(`[`, `*`, `` ` `` 등)의 이스케이프는 prosemirror-markdown 의
// esc() 가 그대로 담당한다 — 여기서는 건드리지 않는다.
export const PreserveText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: { text(value: string, preserveNewlines?: boolean): void }, node: { text: string }) {
          state.text(node.text, true);
        },
        parse: {
          // markdown-it 이 처리한다 (기본 동작 유지)
        },
      },
    };
  },
});
