import type { ExecutionResult } from "../kernel/protocol";

export type ReportCell = {
  type: "markdown" | "code";
  source: string;
  status?: "" | "running" | "done" | "error" | "skipped" | "stale";
  result?: ExecutionResult;
};

export type NotebookReport = {
  workspaceName: string;
  filename: string;
  cells: ReportCell[];
  generatedAt: string;
  lesson?: { title: string; sourceTitle: string; sourceUrl: string };
  missingData: string[];
  runRecord?: unknown;
};

export type ReportOptions = {
  includeCode: boolean;
  includeProvenance: boolean;
  figureFormat?: "svg" | "png";
};
export type ReportFormat = "html" | "pdf" | "markdown" | "notebook" | "script" | "project";

export function reportIssues(report: NotebookReport) {
  const code = report.cells.filter(cell => cell.type === "code");
  const issues: string[] = [];
  const notRun = code.filter(cell => !cell.result).length;
  const stale = code.filter(cell => cell.status === "stale").length;
  const failed = code.filter(cell => cell.status === "error" || cell.result?.ok === false).length;
  const running = code.filter(cell => cell.status === "running").length;
  const backends = new Set(code.map(cell => cell.result?.backend).filter(Boolean));
  if (report.missingData.length) issues.push(`${report.missingData.length} required data file${report.missingData.length === 1 ? " is" : "s are"} not prepared.`);
  if (notRun) issues.push(`${notRun} code cell${notRun === 1 ? " has" : "s have"} not been run.`);
  if (stale) issues.push(`${stale} result${stale === 1 ? " is" : "s are"} stale after a code or dependency change.`);
  if (failed) issues.push(`${failed} code cell${failed === 1 ? " ended" : "s ended"} with an error.`);
  if (running) issues.push(`${running} code cell${running === 1 ? " is" : "s are"} still running.`);
  if (backends.size > 1) issues.push(`Results use ${backends.size} different execution backends.`);
  return issues;
}

export function safeReportBase(filename: string) {
  return filename.replace(/\.(bln|md)$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "biolang-report";
}
