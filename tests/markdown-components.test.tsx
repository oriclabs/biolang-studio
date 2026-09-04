// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lessonSectionFromHref, markdownComponents } from "../src/markdown-components";

const guide = `> **Understanding Kaplan-Meier curves**
>
> **Use it when:** follow-up can be censored.
>
> **Watch out for:** sparse late risk sets.`;

beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

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

describe("lesson-section Markdown links", () => {
  it("recognises encoded internal section targets without treating ordinary anchors as navigation", () => {
    expect(lessonSectionFromHref("#lesson-section=biomedical-02-risk-and-odds")).toBe("biomedical-02-risk-and-odds");
    expect(lessonSectionFromHref("#lesson-section=dna%20statistics")).toBe("dna statistics");
    expect(lessonSectionFromHref("#ordinary-heading")).toBeUndefined();
  });

  it("routes an internal section link through Studio without changing the URL fragment", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const navigate = vi.fn();
    const root = createRoot(host);
    act(() => root.render(<ReactMarkdown components={markdownComponents({ onLessonSection: navigate })}>{"[Next](#lesson-section=trials)"}</ReactMarkdown>));
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    act(() => link.click());
    expect(navigate).toHaveBeenCalledWith("trials");
    expect(location.hash).toBe("");
    act(() => root.unmount());
    host.remove();
  });
});
