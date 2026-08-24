import { HardBreak } from "@tiptap/extension-hard-break";

// breaks:true 아래에서 문단 안 줄바꿈(hardBreak 노드)을 `\n`으로 직렬화해
// soft break를 바이트 그대로 보존한다(무결성 감사 M15).
//
// 단, tiptap-markdown 기본 직렬화기의 두 분기는 유지해야 한다(2차 감사 R1):
// - 표 안에서는 `\n`을 쓰면 행이 쪼개져 표가 붕괴하므로 `<br>`로 쓴다
//   (옵시디언 표 다중행 관용구와 동일 — 파싱 시 <br>→hardBreak 왕복 보존).
// - 블록 끝의 trailing break는 생략한다(기본 동작과 동일 — 뒤에 실제 내용이
//   있는 break만 의미가 있다).
export const SoftBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(text: string): void; inTable?: boolean },
          node: { type: unknown },
          parent: { childCount: number; child(i: number): { type: unknown } },
          index: number,
        ) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write(state.inTable ? "<br>" : "\n");
              return;
            }
          }
        },
        parse: {
          // markdown-it(breaks:true)이 처리한다
        },
      },
    };
  },
});
