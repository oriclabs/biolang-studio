import { useState } from "react";
import type { ReportFormat, ReportOptions } from "./export/model";

export function ExportNotebookDialog({ issues, busy, close, submit }: { issues: string[]; busy: boolean; close: () => void; submit: (format: ReportFormat, options: ReportOptions) => void }) {
  const [format, setFormat] = useState<ReportFormat>("html");
  const [includeCode, setIncludeCode] = useState(true);
  const [includeProvenance, setIncludeProvenance] = useState(true);
  const [figureFormat, setFigureFormat] = useState<"svg" | "png">("svg");
  const action = format === "html" ? "Export HTML" : format === "pdf" ? "Open print view" : "Export Markdown ZIP";
  return <div className="modal-backdrop"><form className="modal export-dialog" onSubmit={event => { event.preventDefault(); submit(format, { includeCode, includeProvenance, figureFormat }); }}>
    <h2>Export notebook</h2>
    <p>Create a readable snapshot. Raw datasets, cached files and credentials are never embedded.</p>
    {issues.length > 0 && <div className="export-readiness" role="alert"><strong>Check before sharing</strong><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul><span>You can still export; the report will disclose these states.</span></div>}
    <fieldset><legend>Format</legend><label><input type="radio" name="export-format" value="html" checked={format === "html"} onChange={() => setFormat("html")} /><span><strong>Self-contained HTML</strong><small>Best for viewing and sharing.</small></span></label><label><input type="radio" name="export-format" value="pdf" checked={format === "pdf"} onChange={() => setFormat("pdf")} /><span><strong>Print / Save PDF</strong><small>Opens the same report in a print-ready view.</small></span></label><label><input type="radio" name="export-format" value="markdown" checked={format === "markdown"} onChange={() => setFormat("markdown")} /><span><strong>Markdown bundle</strong><small>ZIP containing report.md, SVG figures and the run record.</small></span></label></fieldset>
    {format === "html" && <fieldset><legend>Figures in HTML</legend><label><input type="radio" name="figure-format" value="svg" checked={figureFormat === "svg"} onChange={() => setFigureFormat("svg")} /><span><strong>Responsive SVG</strong><small>Recommended: sharp at every size and usually smaller.</small></span></label><label><input type="radio" name="figure-format" value="png" checked={figureFormat === "png"} onChange={() => setFigureFormat("png")} /><span><strong>Embedded PNG</strong><small>Best compatibility with document editors and older viewers.</small></span></label></fieldset>}
    <label className="check-label"><input type="checkbox" checked={includeCode} onChange={event => setIncludeCode(event.target.checked)} />Include BioLang code</label>
    <label className="check-label"><input type="checkbox" checked={includeProvenance} onChange={event => setIncludeProvenance(event.target.checked)} />Include runtime and input checksums</label>
    <div><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy ? "Preparing…" : action}</button></div>
  </form></div>;
}
