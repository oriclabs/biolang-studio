export type NotebookCell = {
  id: string;
  type: "markdown" | "code";
  source: string;
  status?: "" | "running" | "done" | "error" | "skipped" | "stale";
};

const EXECUTABLE_LANGUAGES = new Set(["", "bl", "biolang"]);
const normalize = (value: string) => String(value ?? "").replace(/\r\n?/g, "\n");

function push(cells: NotebookCell[], type: NotebookCell["type"], source: string) {
  const value = source.replace(/^\n+|\n+$/g, "");
  if (!value && type === "markdown") return;
  if (type === "markdown" && cells.at(-1)?.type === "markdown") {
    cells.at(-1)!.source += `\n\n${value}`;
    return;
  }
  cells.push({ id: crypto.randomUUID(), type, source: value, status: "" });
}

export function parseNotebook(source: string): NotebookCell[] {
  const lines = normalize(source).split("\n");
  const cells: NotebookCell[] = [];
  let prose: string[] = [];
  const flush = () => { push(cells, "markdown", prose.join("\n")); prose = []; };
  for (let index = 0; index < lines.length;) {
    const fence = lines[index].match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].toLowerCase();
      let end = index + 1;
      const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      while (end < lines.length && !close.test(lines[end])) end += 1;
      if (end < lines.length && EXECUTABLE_LANGUAGES.has(language)) {
        flush(); push(cells, "code", lines.slice(index + 1, end).join("\n"));
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
  return cells.map(cell => {
    const source = normalize(cell.source).replace(/^\n+|\n+$/g, "");
    if (cell.type === "markdown") return source;
    const longest = Math.max(0, ...Array.from(source.matchAll(/`+/g), match => match[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}biolang\n${source}\n${fence}`;
  }).filter(Boolean).join("\n\n") + "\n";
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

