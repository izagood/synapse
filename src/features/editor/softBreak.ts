import { HardBreak } from "@tiptap/extension-hard-break";

export const SoftBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: { write(text: string): void }) {
          state.write("\n");
        },
      },
    };
  },
});
