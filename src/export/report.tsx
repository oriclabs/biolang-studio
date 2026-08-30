import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import type { ExecutionResult, StructuredResult } from "../kernel/protocol";
import type { NotebookReport, ReportOptions } from "./model";
import { reportIssues, safeReportBase } from "./model";
import { createZip, type ZipEntry } from "./zip";
import { svgToPngDataUrl } from "../plot-export";
import { markdownComponents } from "../markdown-components";

type Figure = { path: string; svg: string };
const REPORT_MARKDOWN_COMPONENTS = markdownComponents({ methodGuidesOpen: true });

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const markdownCell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");

function download(bytes: BlobPart[], type: string, filename: string) {
  const url = URL.createObjectURL(new Blob(bytes, { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function sanitizeSvg(markup: string) {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("A plot is not valid SVG and cannot be exported safely.");
  parsed.querySelectorAll("script,foreignObject").forEach(element => element.remove());
  parsed.querySelectorAll("*").forEach(element => [...element.attributes].forEach(attribute => {
    const value = attribute.value.trim();
    if (/^on/i.test(attribute.name) || ((attribute.name === "href" || attribute.name.endsWith(":href")) && value && !value.startsWith("#") && !value.startsWith("data:image/"))) element.removeAttribute(attribute.name);
  }));
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

function structuredValue(result: StructuredResult) {
  if (result.columns && result.rows) return result.rows.map(row => Object.fromEntries(result.columns!.map((column, index) => [column, row[index]])));
  return result.value ?? result;
}

function htmlTable(value: unknown) {
  if (Array.isArray(value)) {
    const records = value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>;
    if (records.length === value.length && records.length) {
      const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
      return `<div class="table"><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${records.slice(0, 100).map(record => `<tr>${columns.map(column => `<td>${escapeHtml(typeof record[column] === "object" ? JSON.stringify(record[column]) : record[column])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${records.length > 100 ? `<p class="preview">First 100 of ${records.length} rows.</p>` : ""}`;
    }
    return `<div class="table"><table><thead><tr><th>#</th><th>Value</th></tr></thead><tbody>${value.slice(0, 100).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(typeof item === "object" ? JSON.stringify(item) : item)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  if (value && typeof value === "object") return `<div class="table"><table class="key-value"><thead><tr><th>Measure</th><th>Value</th></tr></thead><tbody>${Object.entries(value).map(([key, item]) => `<tr><th>${escapeHtml(key.replaceAll("_", " "))}</th><td>${escapeHtml(typeof item === "object" ? JSON.stringify(item) : item)}</td></tr>`).join("")}</tbody></table></div>`;
  return `<pre>${escapeHtml(value)}</pre>`;
}

function renderResultHtml(result: ExecutionResult, figures: Figure[]) {
  const sections: string[] = [];
  if (result.output) sections.push(`<pre class="stdout">${escapeHtml(result.output)}</pre>`);
  if (!result.ok) sections.push(`<div class="error"><strong>Execution stopped here</strong><pre>${escapeHtml(result.error || "Execution failed.")}</pre></div>`);
  for (const structured of result.results ?? []) {
    const markup = typeof structured.data === "string" ? structured.data : typeof structured.value === "string" ? structured.value : "";
    if ((structured.kind === "plot" || structured.format === "svg") && markup.includes("<svg")) {
      const svg = sanitizeSvg(markup); const path = `figures/plot-${String(figures.length + 1).padStart(3, "0")}.svg`;
      figures.push({ path, svg }); sections.push(`<figure>${svg}<figcaption>${escapeHtml(path.split("/").at(-1))}</figcaption></figure>`);
    } else sections.push(htmlTable(structuredValue(structured)));
  }
  if (result.ok && !result.results?.length && result.value && result.value !== "Nil") sections.push(`<pre>${escapeHtml(result.value)}</pre>`);
  return sections.join("\n");
}

function provenanceHtml(report: NotebookReport) {
  if (!report.runRecord) return `<p>No completed run record was available.</p>`;
  const record = report.runRecord as Record<string, any>;
  const runtime = record.runtime ?? {};
  const inputs = Array.isArray(record.inputs) ? record.inputs : [];
  return `<dl><dt>Generated</dt><dd>${escapeHtml(record.generatedAt ?? report.generatedAt)}</dd><dt>Runtime</dt><dd>${escapeHtml(runtime.runtime ?? "unknown")} - ${escapeHtml(runtime.description ?? "")}</dd><dt>Elapsed</dt><dd>${escapeHtml(record.timing?.elapsedMs ?? "unknown")} ms</dd><dt>Source SHA-256</dt><dd><code>${escapeHtml(record.notebook?.executedSourceSha256 ?? "not recorded")}</code></dd></dl>${inputs.length ? `<h3>Inputs</h3><div class="table"><table><thead><tr><th>Path</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>${inputs.map((input: any) => `<tr><td>${escapeHtml(input.path)}</td><td>${escapeHtml(input.size)}</td><td><code>${escapeHtml(input.sha256)}</code></td></tr>`).join("")}</tbody></table></div>` : "<p>No attached input was recorded.</p>"}`;
}

const REPORT_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e293b;background:#eef2f1}*{box-sizing:border-box}body{margin:0}.report{width:min(980px,calc(100% - 32px));margin:28px auto;padding:42px 54px;background:#fff;box-shadow:0 8px 32px rgb(15 23 42 / 10%)}header{padding-bottom:24px;border-bottom:2px solid #7c3aed}header h1{margin:0 0 8px;font-size:32px;color:#0f172a}header p{margin:4px 0;color:#64748b}.cell{margin:24px 0;break-inside:avoid}.markdown{line-height:1.65}.markdown h1{font-size:26px}.markdown h2{margin-top:1.5em;font-size:21px}.code{position:relative;margin:10px 0;padding:14px 16px;overflow-wrap:anywhere;border-left:4px solid #7c3aed;border-radius:5px;background:#f5f3ff;color:#312e81;font:12px/1.55 "Cascadia Code",Consolas,monospace;white-space:pre-wrap}.state{display:inline-block;margin-bottom:6px;padding:2px 7px;border-radius:999px;background:#e2e8f0;color:#475569;font:10px/1.5 ui-sans-serif,system-ui;text-transform:uppercase;letter-spacing:.05em}.state.done{background:#dcfce7;color:#166534}.state.error{background:#fee2e2;color:#991b1b}.state.stale{background:#fef3c7;color:#92400e}.result{margin-top:10px;padding:12px 14px;border:1px solid #e2e8f0;border-radius:7px}.result pre{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap;font:11px/1.5 "Cascadia Code",Consolas,monospace}.stdout{color:#475569}.error{padding:10px;border-left:4px solid #dc2626;background:#fef2f2;color:#991b1b}.table{max-width:100%;overflow-x:auto;overscroll-behavior-inline:contain}table{width:max-content;min-width:100%;border-collapse:collapse;font-size:11px}th,td{padding:6px 8px;border:1px solid #dbe3df;text-align:left;vertical-align:top;overflow-wrap:normal;word-break:normal;white-space:nowrap}th{background:#f8fafc}.key-value{width:100%}.key-value th{width:36%;white-space:normal}.key-value td{white-space:normal;overflow-wrap:break-word}figure{margin:18px 0;padding:8px;break-inside:avoid;border:1px solid #e2e8f0;border-radius:8px}figure svg,figure img{display:block;width:100%;height:auto;max-height:620px;object-fit:contain}figcaption,.preview{margin-top:5px;color:#64748b;font-size:10px}.audit{margin:18px 0;padding:12px 15px;border:1px solid #e8c36f;border-radius:8px;background:#fff8e7;color:#614714}.audit ul{margin:6px 0;padding-left:20px}.provenance{margin-top:36px;padding-top:20px;border-top:2px solid #cbd5e1}.provenance dl{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;font-size:11px}.provenance dt{font-weight:700}.provenance dd{margin:0;overflow-wrap:anywhere}a{color:#6d28d9}footer{margin-top:34px;padding-top:14px;border-top:1px solid #e2e8f0;color:#64748b;font-size:10px}@media(max-width:650px){.report{width:100%;margin:0;padding:24px 18px;box-shadow:none}}@media print{@page{size:A4;margin:13mm}body{background:#fff}.report{width:auto;margin:0;padding:0;box-shadow:none}header h1{font-size:24pt}.cell{break-inside:auto}.code,.result,figure,.table{break-inside:avoid}.table{overflow:visible}table{width:100%;min-width:0;table-layout:auto}th,td{white-space:normal;overflow-wrap:break-word}figure svg,figure img{max-height:210mm}a{color:inherit;text-decoration:none}.no-print{display:none!important}}
`;
const METHOD_GUIDE_REPORT_CSS = `.method-guide{margin:14px 0;border:1px solid #d8e2dd;border-left:4px solid #7c3aed;border-radius:7px;background:#f8faf9}.method-guide summary{padding:9px 12px;font-weight:700}.method-guide>div{padding:1px 14px 9px}`;

export function buildHtmlReport(report: NotebookReport, options: ReportOptions) {
  const figures: Figure[] = [];
  const issues = reportIssues(report);
  const cells = report.cells.map((cell, index) => {
    if (cell.type === "markdown") return `<section class="cell markdown">${renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} components={REPORT_MARKDOWN_COMPONENTS}>{cell.source}</ReactMarkdown>)}</section>`;
    const status = cell.status || "not-run";
    const statusLabel = status === "done" ? "ran" : status === "not-run" ? "not run" : status;
    const code = options.includeCode ? `<div class="code"><span class="state ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>${escapeHtml(cell.source)}</div>` : `<span class="state ${escapeHtml(status)}">Cell ${index + 1}: ${escapeHtml(statusLabel)}</span>`;
    return `<section class="cell">${code}${cell.result ? `<div class="result">${renderResultHtml(cell.result, figures)}</div>` : ""}</section>`;
  }).join("\n");
  const lesson = report.lesson ? `<p>Inspired by <a href="${escapeHtml(report.lesson.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(report.lesson.sourceTitle)}</a>.</p>` : "";
  const audit = issues.length ? `<section class="audit"><strong>Report readiness notes</strong><ul>${issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join("")}</ul></section>` : "";
  const provenance = options.includeProvenance ? `<section class="provenance"><h2>Reproducibility</h2>${provenanceHtml(report)}</section>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.filename)}</title><style>${REPORT_CSS}${METHOD_GUIDE_REPORT_CSS}.code,.result pre,.markdown code{font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}</style></head><body><article class="report"><header><h1>${escapeHtml(report.filename.replace(/\.(bln|md)$/i, ""))}</h1><p>${escapeHtml(report.workspaceName)} - exported ${escapeHtml(report.generatedAt)}</p>${lesson}</header>${audit}${cells}${provenance}<footer>Generated by BioLang Studio. This report does not embed raw datasets or credentials.</footer></article></body></html>`;
  return { html, figures, issues };
}

export async function buildHtmlReportForExport(
  report: NotebookReport,
  options: ReportOptions,
  rasterize: (svg: string) => Promise<string> = svgToPngDataUrl,
) {
  const rendered = buildHtmlReport(report, options);
  if (options.figureFormat !== "png" || rendered.figures.length === 0) return rendered;
  let html = rendered.html;
  for (const figure of rendered.figures) {
    const png = await rasterize(figure.svg);
    html = html.replace(
      figure.svg,
      `<img src="${png}" alt="BioLang plot" decoding="async">`,
    );
  }
  return { ...rendered, html };
}

function markdownTable(value: unknown) {
  if (Array.isArray(value) && value.length && value.every(item => item && typeof item === "object" && !Array.isArray(item))) {
    const records = value as Array<Record<string, unknown>>; const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
    return `| ${columns.map(markdownCell).join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n${records.slice(0, 100).map(record => `| ${columns.map(column => markdownCell(typeof record[column] === "object" ? JSON.stringify(record[column]) : record[column])).join(" | ")} |`).join("\n")}`;
  }
  if (value && typeof value === "object") return `| Measure | Value |\n|---|---|\n${Object.entries(value).map(([key, item]) => `| ${markdownCell(key.replaceAll("_", " "))} | ${markdownCell(typeof item === "object" ? JSON.stringify(item) : item)} |`).join("\n")}`;
  return `\`\`\`text\n${String(value ?? "")}\n\`\`\``;
}

function resultMarkdown(result: ExecutionResult, figures: Figure[]) {
  const blocks: string[] = [];
  if (result.output) blocks.push(`\`\`\`text\n${result.output}\n\`\`\``);
  if (!result.ok) blocks.push(`> **Execution stopped here:** ${String(result.error ?? "Execution failed.").replace(/\r?\n/g, " ")}`);
  for (const structured of result.results ?? []) {
    const markup = typeof structured.data === "string" ? structured.data : typeof structured.value === "string" ? structured.value : "";
    if ((structured.kind === "plot" || structured.format === "svg") && markup.includes("<svg")) {
      const path = `figures/plot-${String(figures.length + 1).padStart(3, "0")}.svg`; figures.push({ path, svg: sanitizeSvg(markup) }); blocks.push(`![BioLang plot](${path})`);
    } else blocks.push(markdownTable(structuredValue(structured)));
  }
  if (result.ok && !result.results?.length && result.value && result.value !== "Nil") blocks.push(`\`\`\`text\n${result.value}\n\`\`\``);
  return blocks.join("\n\n");
}

export function buildMarkdownBundle(report: NotebookReport, options: ReportOptions) {
  const figures: Figure[] = []; const issues = reportIssues(report);
  const parts = [`# ${report.filename.replace(/\.(bln|md)$/i, "")}`, `_${report.workspaceName}; exported ${report.generatedAt}_`];
  if (report.lesson) parts.push(`Inspired by [${report.lesson.sourceTitle}](${report.lesson.sourceUrl}).`);
  if (issues.length) parts.push(`> **Report readiness:**\n> ${issues.join("\n> ")}`);
  for (const [index, cell] of report.cells.entries()) {
    if (cell.type === "markdown") parts.push(cell.source);
    else {
      if (options.includeCode) parts.push(`\`\`\`biolang\n${cell.source}\n\`\`\``);
      if (cell.result) parts.push(resultMarkdown(cell.result, figures));
      else parts.push(`> Cell ${index + 1} was not run.`);
    }
  }
  if (options.includeProvenance) parts.push(`## Reproducibility\n\nSee \`run.json\` for the machine-readable run record and input checksums.`);
  const entries: ZipEntry[] = [{ name: "report.md", data: `${parts.filter(Boolean).join("\n\n")}\n` }, ...figures.map(figure => ({ name: figure.path, data: figure.svg }))];
  if (options.includeProvenance) entries.push({ name: "run.json", data: `${JSON.stringify(report.runRecord ?? { available: false }, null, 2)}\n` });
  entries.push({ name: "manifest.json", data: `${JSON.stringify({ schema: 1, kind: "biolang-report-bundle", generatedAt: report.generatedAt, notebook: report.filename, issues, files: [...entries.map(entry => entry.name), "manifest.json"] }, null, 2)}\n` });
  return { bytes: createZip(entries, new Date(report.generatedAt)), entries, issues };
}

export async function exportHtml(report: NotebookReport, options: ReportOptions) {
  const rendered = await buildHtmlReportForExport(report, options); download([rendered.html], "text/html;charset=utf-8", `${safeReportBase(report.filename)}.html`); return rendered;
}

export function exportMarkdown(report: NotebookReport, options: ReportOptions) {
  const bundle = buildMarkdownBundle(report, options); download([bundle.bytes], "application/zip", `${safeReportBase(report.filename)}-markdown.zip`); return bundle;
}

export function openPrintReport(report: NotebookReport, options: ReportOptions, target: Window) {
  const rendered = buildHtmlReport(report, options);
  target.document.open(); target.document.write(rendered.html); target.document.close();
  target.document.title = `${safeReportBase(report.filename)} - Print`;
  setTimeout(() => { target.focus(); target.print(); }, 250);
  return rendered;
}
