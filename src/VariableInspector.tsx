import { useEffect, useRef, useState } from "react";
import type { VariableExport, VariableExportFormat, VariablePage, VariableSummary } from "./kernel/protocol";

const PAGE_SIZE = 20;
const MAX_BROWSER_EXPORT_BYTES = 10 * 1024 * 1024;
const MAX_BROWSER_EXPORT_WORK_BYTES = 128 * 1024 * 1024;

type Notice = { tone: "info" | "good" | "bad"; text: string };

function displayBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function shapeLabel(variable: VariableSummary) {
  if (variable.rows !== undefined && variable.columns !== undefined) return `${variable.rows} × ${variable.columns}`;
  if (variable.length !== undefined) return `${variable.length} item${variable.length === 1 ? "" : "s"}`;
  return "";
}

function exportFormat(variable: VariableSummary): VariableExportFormat {
  const type = variable.typeName.toLowerCase();
  return ["table", "matrix", "quality"].includes(type) ? "csv"
    : ["str", "dna", "rna", "protein"].includes(type) ? "text" : "json";
}

function download(filename: string, contents: BlobPart, mediaType: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface VariableInspectorProps {
  variables: VariableSummary[];
  revision: number;
  canInspect: boolean;
  exportMode: "capped" | "streaming" | "none";
  canRemove?: boolean;
  inspect(name: string, offset: number, limit: number): Promise<VariablePage>;
  exportExact(name: string, format: VariableExportFormat, maximumBytes: number): Promise<VariableExport>;
  publishOutput?(variable: VariableSummary, format: VariableExportFormat): Promise<void>;
  remove?(name: string): Promise<void>;
  notify(notice: Notice): void;
}

export function VariableInspector({ variables, revision, canInspect, exportMode, canRemove = false, inspect, exportExact, publishOutput, remove, notify }: VariableInspectorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const expandedRef = useRef(expanded);
  const [pages, setPages] = useState<Record<string, VariablePage>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const available = new Set(variables.map(variable => variable.name));
    const retained = [...expandedRef.current].filter(name => available.has(name));
    const nextExpanded = new Set(retained);
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    setPages({});
    setErrors({});
    retained.forEach(name => void load(name));
  }, [revision]);

  async function load(name: string, offset = 0) {
    if (!canInspect) return;
    setLoading(current => new Set(current).add(name));
    setErrors(current => { const next = { ...current }; delete next[name]; return next; });
    try {
      const nextPage = await inspect(name, offset, PAGE_SIZE);
      setPages(current => offset === 0 ? { ...current, [name]: nextPage } : {
        ...current,
        [name]: { ...nextPage, offset: current[name]?.offset ?? 0, rows: [...(current[name]?.rows ?? []), ...nextPage.rows] }
      });
    } catch (error) {
      setErrors(current => ({ ...current, [name]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLoading(current => { const next = new Set(current); next.delete(name); return next; });
    }
  }

  async function toggle(name: string) {
    const opening = !expanded.has(name);
    setExpanded(current => { const next = new Set(current); opening ? next.add(name) : next.delete(name); expandedRef.current = next; return next; });
    if (opening && !pages[name]) await load(name);
  }

  async function copyPreview(variable: VariableSummary) {
    const value = `${variable.name} = ${variable.preview}`;
    try {
      await navigator.clipboard.writeText(value);
      notify({ tone: "good", text: `Copied ${variable.name}'s preview.` });
    } catch {
      notify({ tone: "info", text: value });
    }
  }

  async function exportValue(variable: VariableSummary) {
    // Keep sparse values sparse: CSV would densify every absent cell and can turn a
    // small in-memory object into a very large download.
    const format = exportFormat(variable);
    if (exportMode === "none") {
      notify({ tone: "info", text: `This kernel does not yet expose its save dialog. In native BioLang use :export ${variable.name} ${variable.name}.${format === "text" ? "txt" : format}; SOMER analyses should declare an output file.` });
      return;
    }
    if (exportMode === "capped" && variable.sizeBytes > MAX_BROWSER_EXPORT_WORK_BYTES) {
      notify({ tone: "info", text: `${variable.name} is too large to serialize safely in the browser. Use :export ${variable.name} ${variable.name}.${format === "text" ? "txt" : format} in Desktop or CLI so it streams directly to a file.` });
      return;
    }
    try {
      const result = await exportExact(variable.name, format, MAX_BROWSER_EXPORT_BYTES);
      if (result.cancelled) { notify({ tone: "info", text: `Export of ${variable.name} was cancelled.` }); return; }
      if (result.savedPath) { notify({ tone: "good", text: `Streamed ${variable.name} to ${result.savedPath} (${displayBytes(result.byteLength ?? 0)}).` }); return; }
      if (!result.bytes) throw new Error("The kernel returned no export data or saved file.");
      download(result.filename, result.bytes, `${result.mediaType};charset=utf-8`);
      notify({ tone: "good", text: `Exported the complete ${variable.name} value (${displayBytes(result.bytes.byteLength)}).` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify({ tone: "bad", text: `${message} Use :export ${variable.name} ${variable.name}.${format === "text" ? "txt" : format} in Desktop or CLI for a streaming export.` });
    }
  }

  async function removeValue(name: string) {
    if (!canRemove || !remove || !confirm(`Remove ${name} from the current kernel? Re-running its defining cell will restore it.`)) return;
    try {
      await remove(name);
      notify({ tone: "good", text: `Removed ${name} from the current kernel.` });
    } catch (error) {
      notify({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }

  return <details className="variables-disclosure">
    <summary><span>Variables</span><small>{variables.length}</small></summary>
    {!variables.length && <p className="muted">Run code to inspect values in memory.</p>}
    {variables.length > 0 && <div className="variable-list">
      {variables.map(variable => {
        const page = pages[variable.name];
        const isExpanded = expanded.has(variable.name);
        const isLoading = loading.has(variable.name);
        return <article className={`variable-item ${isExpanded ? "expanded" : ""}`} key={variable.name}>
          <div className="variable-row">
            <button className="variable-open" aria-expanded={isExpanded} disabled={!canInspect} onClick={() => void toggle(variable.name)} title={canInspect ? `Inspect ${variable.name}` : "This kernel exposes summaries only"}>
              <span className="variable-chevron">{canInspect ? isExpanded ? "▾" : "▸" : "·"}</span>
              <span className="variable-identity"><strong>{variable.name}</strong><small>{variable.typeName}</small></span>
              <span className="variable-preview" title={variable.preview}>{variable.preview}</span>
            </button>
            <details className="variable-actions">
              <summary aria-label={`Actions for ${variable.name}`} title={`Actions for ${variable.name}`}>⋯</summary>
              <div><button onClick={() => void copyPreview(variable)}>Copy preview</button><button onClick={() => void exportValue(variable)}>Export value</button>{publishOutput && exportMode !== "none" && <button onClick={() => void publishOutput(variable, exportFormat(variable))}>Publish output…</button>}{canRemove && remove && <button className="danger" onClick={() => void removeValue(variable.name)}>Remove</button>}</div>
            </details>
          </div>
          <div className="variable-meta"><span>{shapeLabel(variable)}</span><span>{variable.sizeApproximate ? "≈" : ""}{displayBytes(variable.sizeBytes)}</span></div>
          {isExpanded && <div className="variable-detail">
            {isLoading && !page && <p className="muted">Loading a 20-row preview…</p>}
            {errors[variable.name] && <p className="variable-error">{errors[variable.name]}</p>}
            {page && <>
              <div className="variable-table-wrap"><table><thead><tr>{page.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead><tbody>{page.rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{String(value ?? "")}</td>)}</tr>)}</tbody></table></div>
              {page.columnsTruncated && <p className="variable-limit">Showing the first 50 columns.</p>}
              <div className="variable-page-status"><span>{page.rows.length} of {page.total} rows loaded</span>{page.truncated && <button disabled={isLoading} onClick={() => void load(variable.name, page.nextOffset)}>{isLoading ? "Loading…" : "Load 20 more"}</button>}</div>
            </>}
          </div>}
        </article>;
      })}
    </div>}
  </details>;
}
