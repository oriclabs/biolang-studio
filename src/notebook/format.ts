export type NotebookCell = {
  id: string;
  type: "markdown" | "code";
  source: string;
  javascriptSource?: string;
  javascriptIndependent?: boolean;
  status?: "" | "running" | "done" | "error" | "skipped" | "stale";
  step?: { id: string; title: string };
};

const EXECUTABLE_LANGUAGES = new Set(["", "bl", "biolang"]);
const normalize = (value: string) => String(value ?? "").replace(/\r\n?/g, "\n");

function push(cells: NotebookCell[], type: NotebookCell["type"], source: string, step?: NotebookCell["step"], javascriptSource?: string, javascriptIndependent = false) {
  const value = source.replace(/^\n+|\n+$/g, "");
  if (!value && type === "markdown") return;
  if (type === "markdown" && cells.at(-1)?.type === "markdown" && cells.at(-1)?.step?.id === step?.id) {
    cells.at(-1)!.source += `\n\n${value}`;
    return;
  }
  cells.push({ id: crypto.randomUUID(), type, source: value, status: "", ...(step ? { step } : {}), ...(javascriptSource ? { javascriptSource, ...(javascriptIndependent ? { javascriptIndependent: true } : {}) } : {}) });
}

const stepStart = /^\s*<!--\s*bl:step(?:\s+title=(?:"([^"]*)"|'([^']*)'))?\s*-->\s*$/i;
const stepEnd = /^\s*<!--\s*\/bl:step\s*-->\s*$/i;
const languageMarker = /^\s*<!--\s*bl:language\s+(?:biolang|javascript)\s*-->\s*$/i;
const executableFence = /^\s*(?:`{3,}|~{3,})\s*(?:bl|biolang)\s*$/im;

function decodeTitle(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function encodeTitle(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function parseNotebook(source: string): NotebookCell[] {
  const lines = normalize(source).split("\n");
  const cells: NotebookCell[] = [];
  let prose: string[] = [];
  let step: NotebookCell["step"] | undefined;
  let pendingJavaScript: string | undefined;
  let pendingJavaScriptIndependent = false;
  const flush = () => { push(cells, "markdown", prose.join("\n"), step); prose = []; };
  for (let index = 0; index < lines.length;) {
    if (languageMarker.test(lines[index])) { index += 1; continue; }
    const opening = lines[index].match(stepStart);
    if (opening && !step) {
      flush(); step = { id: crypto.randomUUID(), title: decodeTitle(opening[1] ?? opening[2] ?? "") }; index += 1; continue;
    }
    if (stepEnd.test(lines[index]) && step) {
      flush(); step = undefined; index += 1; continue;
    }
    const fence = lines[index].match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].toLowerCase();
      let end = index + 1;
      const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      while (end < lines.length && !close.test(lines[end])) end += 1;
      if (end < lines.length && (language === "javascript+biolang" || language === "javascript+standard")) {
        flush(); pendingJavaScript = lines.slice(index + 1, end).join("\n").replace(/^\n+|\n+$/g, ""); pendingJavaScriptIndependent = language === "javascript+standard";
      } else if (end < lines.length && EXECUTABLE_LANGUAGES.has(language)) {
        flush(); push(cells, "code", lines.slice(index + 1, end).join("\n"), step, pendingJavaScript, pendingJavaScriptIndependent); pendingJavaScript = undefined; pendingJavaScriptIndependent = false;
      } else prose.push(...lines.slice(index, Math.min(end + 1, lines.length)));
      index = Math.min(end + 1, lines.length);
      continue;
    }
    prose.push(lines[index++]);
  }
  flush();
  return cells.length ? cells : [{ id: crypto.randomUUID(), type: "markdown", source: "", status: "" }];
}

export function serializeNotebook(cells: NotebookCell[]) {
  const chunks: string[] = [];
  let activeStep = "";
  for (const cell of cells) {
    if (activeStep && activeStep !== cell.step?.id) chunks.push("<!-- /bl:step -->");
    if (cell.step && activeStep !== cell.step.id) chunks.push(`<!-- bl:step${cell.step.title ? ` title="${encodeTitle(cell.step.title)}"` : ""} -->`);
    activeStep = cell.step?.id ?? "";
    const source = normalize(cell.source).replace(/^\n+|\n+$/g, "");
    if (cell.type === "markdown") chunks.push(source);
    else {
      const longest = Math.max(0, ...Array.from(source.matchAll(/`+/g), match => match[0].length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      if (cell.javascriptSource) {
        const javascript = normalize(cell.javascriptSource).replace(/^\n+|\n+$/g, "");
        const javascriptLongest = Math.max(0, ...Array.from(javascript.matchAll(/`+/g), match => match[0].length));
        const javascriptFence = "`".repeat(Math.max(3, javascriptLongest + 1));
        chunks.push(`${javascriptFence}${cell.javascriptIndependent ? "javascript+standard" : "javascript+biolang"}\n${javascript}\n${javascriptFence}`);
      }
      chunks.push(`${fence}biolang\n${source}\n${fence}`);
    }
  }
  if (activeStep) chunks.push("<!-- /bl:step -->");
  return chunks.filter(Boolean).join("\n\n") + "\n";
}

export function expandMixedMarkdown(cell: NotebookCell): NotebookCell[] {
  if (cell.type !== "markdown" || !executableFence.test(cell.source)) return [cell];
  const expanded = parseNotebook(cell.source);
  if (!expanded.some(item => item.type === "code")) return [cell];
  return expanded.map(item => item.step || !cell.step ? item : { ...item, step: cell.step });
}

export function directives(source: string) {
  const found = new Set<string>();
  for (const line of normalize(source).split("\n")) {
    const match = line.match(/^\s*#\s*@(hide-output|hide-code|hide|skip|echo)\s*$/i);
    if (match) found.add(match[1].toLowerCase());
    else if (line.trim() && !line.trimStart().startsWith("#")) break;
  }
  return {
    skip: found.has("skip"),
    hideCode: found.has("hide") || found.has("hide-code"),
    hideOutput: found.has("hide") || found.has("hide-output")
  };
}

export function executableSource(source: string) {
  return normalize(source).split("\n")
    .filter(line => !/^\s*#\s*@(hide-output|hide-code|hide|skip|echo)\s*$/i.test(line))
    .join("\n").trim();
}
