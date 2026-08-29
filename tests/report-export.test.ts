// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildHtmlReport, buildHtmlReportForExport, buildMarkdownBundle } from "../src/export/report";
import { reportIssues, type NotebookReport } from "../src/export/model";

function report(cells: NotebookReport["cells"]): NotebookReport {
  return { workspaceName: "Teaching workspace", filename: "essential-stats.bln", generatedAt: "2026-08-28T10:00:00.000Z", cells, missingData: [], runRecord: { runtime: { runtime: "browser", description: "BioLang WASM" }, inputs: [], notebook: { executedSourceSha256: "a".repeat(64) }, timing: { elapsedMs: 12 } } };
}

function localZipNames(bytes: Uint8Array) {
  const names: string[] = []; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true); const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

describe("notebook report export", () => {
  it("reports incomplete, stale, failed, missing-data, and mixed-backend states", () => {
    const issues = reportIssues({ ...report([
      { type: "code", source: "1", status: "stale", result: { ok: true, backend: "browser", value: "1" } },
      { type: "code", source: "bad()", status: "error", result: { ok: false, backend: "desktop", error: "bad" } },
      { type: "code", source: "2" },
    ]), missingData: ["nhanes.csv"] });
    expect(issues.join(" ")).toMatch(/not prepared.*not been run.*stale.*error.*different execution backends/);
  });

  it("creates self-contained readable HTML and sanitizes exported SVG", () => {
    const output = buildHtmlReport(report([
      { type: "markdown", source: "# Result\n\nA [readable explanation](https://example.org/method)." },
      { type: "code", source: "values |> summary()", status: "done", result: { ok: true, backend: "browser", results: [
        { kind: "record", value: { mean: 17, median: 15 } },
        { kind: "plot", format: "svg", data: '<svg viewBox="0 0 10 10" onclick="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="2"/></svg>' },
      ] } },
    ]), { includeCode: true, includeProvenance: true });
    expect(output.html).toContain("<h1>Result</h1>");
    expect(output.html).toContain("<th>mean</th>");
    expect(output.html).toContain("values |&gt; summary()");
    expect(output.html).toContain('target="_blank"');
    expect(output.html).toContain('rel="noopener noreferrer"');
    expect(output.html).toContain("font-variant-ligatures:none");
    expect(output.html).toContain(".table{max-width:100%;overflow-x:auto");
    expect(output.html).toContain("overflow-wrap:normal;word-break:normal;white-space:nowrap");
    expect(output.html).not.toContain("onclick=");
    expect(output.html).not.toContain("<script");
    expect(output.figures).toHaveLength(1);
  });

  it("builds a portable Markdown ZIP with SVG and provenance", () => {
    const bundle = buildMarkdownBundle(report([{ type: "code", source: "plot", status: "done", result: { ok: true, results: [{ kind: "plot", format: "svg", data: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>' }] } }]), { includeCode: true, includeProvenance: true });
    expect(localZipNames(bundle.bytes)).toEqual(["report.md", "figures/plot-001.svg", "run.json", "manifest.json"]);
    expect(bundle.entries.find(entry => entry.name === "report.md")?.data).toContain("![BioLang plot](figures/plot-001.svg)");
  });

  it("can embed PNG figures in a self-contained HTML report", async () => {
    const output = await buildHtmlReportForExport(report([{ type: "code", source: "plot", status: "done", result: { ok: true, results: [{ kind: "plot", format: "svg", data: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>' }] } }]), { includeCode: true, includeProvenance: true, figureFormat: "png" }, async () => "data:image/png;base64,cG5n");
    expect(output.html).toContain('<img src="data:image/png;base64,cG5n"');
    expect(output.html).not.toContain('<circle cx="5"');
  });
});
