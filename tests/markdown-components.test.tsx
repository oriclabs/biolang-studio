import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { markdownComponents } from "../src/markdown-components";

const guide = `> **Understanding Kaplan-Meier curves**
>
> **Use it when:** follow-up can be censored.
>
> **Watch out for:** sparse late risk sets.`;

describe("method-guide Markdown", () => {
  it("renders understanding callouts as collapsed Studio disclosures", () => {
    const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents()}>{guide}</ReactMarkdown>);
    expect(html).toContain('<details class="method-guide">');
    expect(html).toContain("<summary>Understanding Kaplan-Meier curves</summary>");
    expect(html).not.toContain("<summary><p>");
    expect(html).not.toContain(" open");
  });

  it("opens method guides in exported reports and preserves ordinary quotes", () => {
    const report = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents({ methodGuidesOpen: true })}>{guide}</ReactMarkdown>);
    const quote = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents()}>{"> Ordinary quotation"}</ReactMarkdown>);
    expect(report).toContain('<details class="method-guide" open="">');
    expect(quote).toContain("<blockquote>");
  });
});
