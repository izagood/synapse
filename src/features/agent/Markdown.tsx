import { Fragment } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown";

// 에이전트 응답을 안전하게 렌더링한다. 원시 HTML은 해석하지 않으며
// (dangerouslySetInnerHTML 미사용), 텍스트/코드/링크만 React 엘리먼트로 만든다.

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "bold":
            return <strong key={i}>{node.value}</strong>;
          case "italic":
            return <em key={i}>{node.value}</em>;
          case "code":
            return <code key={i}>{node.value}</code>;
          case "link":
            return (
              <a key={i} href={node.href} target="_blank" rel="noreferrer noopener">
                {node.text}
              </a>
            );
          default:
            return <Fragment key={i}>{node.value}</Fragment>;
        }
      })}
    </>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case "code":
      return (
        <pre className="agent-md-code">
          <code>{block.value}</code>
        </pre>
      );
    case "heading": {
      const Tag = (`h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6");
      return (
        <Tag>
          <InlineNodes nodes={block.children} />
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote>
          <InlineNodes nodes={block.children} />
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <InlineNodes nodes={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    default:
      return (
        <p>
          <InlineNodes nodes={block.children} />
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="agent-md">
      {blocks.map((block, i) => (
        <BlockNode key={i} block={block} />
      ))}
    </div>
  );
}
