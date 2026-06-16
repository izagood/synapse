import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { createLowlight } from "lowlight";
import { isMermaidLanguage, renderMermaid } from "./mermaid";

type Lowlight = ReturnType<typeof createLowlight>;

export interface MermaidBlockOptions {
  lowlight: Lowlight;
  /** 렌더 실패 시 보여줄 레이블 (i18n) */
  errorLabel: string;
}

// 다른 코드 블록처럼 보이는 동안 타이핑이 미리보기를 과도하게 다시 그리지 않도록
// 약간의 디바운스를 둔다.
const RENDER_DEBOUNCE_MS = 200;

/**
 * CodeBlockLowlight를 확장해 ```mermaid 코드 블록을 다이어그램으로 렌더링한다.
 *
 * - 노드 타입은 그대로 codeBlock이라 md 직렬화(```mermaid …)와 라운드트립이 보존된다.
 * - mermaid 블록은 NodeView로 "편집 가능한 소스 + 실시간 미리보기"를 함께 보여준다.
 * - mermaid가 아닌 코드 블록은 기본 렌더(pre > code)를 그대로 재현하므로
 *   lowlight 데코레이션(hljs-*)이 종전대로 적용된다.
 */
export function MermaidCodeBlock(options: MermaidBlockOptions) {
  const { lowlight, errorLabel } = options;
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ({ node }) => {
        let currentNode = node;
        const isMermaid = (n: ProseMirrorNode) => isMermaidLanguage(n.attrs.language);

        const dom = document.createElement("div");
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        const language = node.attrs.language as string | null;
        if (language) code.classList.add(`language-${language}`);
        pre.appendChild(code);

        // mermaid가 아닌 코드 블록: 기본 구조 그대로 (lowlight가 code 안을 데코레이션)
        if (!isMermaid(node)) {
          dom.appendChild(pre);
          return {
            dom,
            contentDOM: code,
            update(updated: ProseMirrorNode) {
              if (updated.type !== currentNode.type) return false;
              // 언어가 mermaid로 바뀌면 NodeView를 새로 만들어야 한다
              if (isMermaid(updated)) return false;
              currentNode = updated;
              return true;
            },
          };
        }

        // --- mermaid 블록 ---
        dom.className = "mermaid-block";
        const preview = document.createElement("div");
        preview.className = "mermaid-preview";
        preview.setAttribute("contenteditable", "false");
        // 미리보기를 위에, 편집 가능한 소스를 아래에 둔다
        dom.appendChild(preview);
        dom.appendChild(pre);

        let timer: ReturnType<typeof setTimeout> | null = null;
        let token = 0;
        let lastSource: string | null = null;

        const paint = (source: string) => {
          const mine = ++token;
          // 빈 블록(새로 만들었거나 비운 경우)은 오류 대신 깔끔히 비워둔다
          if (!source.trim()) {
            preview.classList.remove("mermaid-error");
            preview.replaceChildren();
            return;
          }
          void renderMermaid(source).then((result) => {
            if (mine !== token) return; // 더 새로운 렌더가 시작됨 — 버린다
            if (result.ok) {
              preview.classList.remove("mermaid-error");
              preview.innerHTML = result.svg;
            } else {
              preview.classList.add("mermaid-error");
              preview.textContent = `${errorLabel}: ${result.error}`;
            }
          });
        };

        const schedule = (source: string, immediate = false) => {
          if (source === lastSource) return;
          lastSource = source;
          if (timer) clearTimeout(timer);
          if (immediate) {
            paint(source);
          } else {
            timer = setTimeout(() => paint(source), RENDER_DEBOUNCE_MS);
          }
        };

        schedule(node.textContent, true);

        return {
          dom,
          contentDOM: code,
          update(updated: ProseMirrorNode) {
            if (updated.type !== currentNode.type) return false;
            // 더 이상 mermaid가 아니면 새로 만든다
            if (!isMermaid(updated)) return false;
            currentNode = updated;
            schedule(updated.textContent);
            return true;
          },
          // mermaid 미리보기는 비편집 영역이므로 그 안의 DOM 변경을 PM이 무시하게 한다
          ignoreMutation(mutation) {
            return preview.contains(mutation.target);
          },
          destroy() {
            token++; // 진행 중인 렌더 결과를 무효화
            if (timer) clearTimeout(timer);
          },
        };
      };
    },
  }).configure({ lowlight });
}
