import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function MethodGuide({ children, open }: { children?: ReactNode; open: boolean }) {
  const items = Children.toArray(children);
  const titleIndex = items.findIndex(item => nodeText(item).trim().length > 0);
  const title = titleIndex >= 0 ? nodeText(items[titleIndex]).trim() : "";
  if (!title.startsWith("Understanding ")) return <blockquote>{children}</blockquote>;
  return <details className="method-guide" open={open || undefined}>
    <summary>{title}</summary>
    <div>{items.filter((_, index) => index !== titleIndex)}</div>
  </details>;
}

export function markdownComponents(options: { methodGuidesOpen?: boolean } = {}): Components {
  return {
    a: ({ href, children, ...props }) => {
      const external = /^https?:\/\//i.test(href ?? "");
      return <a href={href} {...props} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
    },
    blockquote: ({ children }) => <MethodGuide open={options.methodGuidesOpen ?? false}>{children}</MethodGuide>,
  };
}
