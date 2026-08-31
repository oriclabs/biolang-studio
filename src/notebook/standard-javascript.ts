import { parse } from "acorn";

type Node = { type: string; start: number; end: number; [key: string]: unknown };
export type JavaScriptIssue = { message: string; start: number; end: number };
export type StandardJavaScript =
  | { ok: true; executable: string; declared: string[] }
  | { ok: false; issues: JavaScriptIssue[] };

type BioLangResultEnvelope = {
  ok: boolean;
  value?: unknown;
  type?: unknown;
  error?: unknown;
  structured?: unknown;
  results?: unknown[];
};

const BLOCKED_NAMES = new Set([
  "document", "eval", "fetch", "Function", "globalThis", "importScripts", "indexedDB",
  "location", "navigator", "self", "WebSocket", "window", "Worker", "XMLHttpRequest",
]);
const BLOCKED_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

function issue(node: Node, message: string): JavaScriptIssue {
  return { message, start: node.start, end: Math.max(node.end, node.start + 1) };
}

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object" && typeof item.type === "string") children.push(item as Node);
    } else if (value && typeof value === "object" && typeof (value as Node).type === "string") children.push(value as Node);
  }
  return children;
}

function validateSecurity(node: Node, parent: Node | null, issues: JavaScriptIssue[]) {
  if (node.type === "ImportExpression") issues.push(issue(node, "Dynamic imports are disabled in notebook JavaScript."));
  if (node.type === "ThisExpression") issues.push(issue(node, "The worker global object is unavailable in notebook JavaScript."));
  if (node.type === "Identifier" && BLOCKED_NAMES.has(String(node.name))) {
    const propertyKey = parent?.type === "Property" && parent.key === node && !parent.computed && !(parent.shorthand && parent.value === node);
    const memberKey = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
    const declaration = parent && ["VariableDeclarator", "FunctionDeclaration", "ClassDeclaration"].includes(parent.type) && parent.id === node;
    if (!propertyKey && !memberKey && !declaration) issues.push(issue(node, `'${String(node.name)}' is unavailable in isolated notebook JavaScript.`));
  }
  if (node.type === "MemberExpression") {
    const property = node.property as Node;
    const name = !node.computed && property.type === "Identifier" ? String(property.name)
      : node.computed && property.type === "Literal" ? String(property.value) : "";
    if (BLOCKED_PROPERTIES.has(name)) issues.push(issue(property, `Property '${name}' is disabled in isolated notebook JavaScript.`));
  }
  for (const child of childNodes(node)) validateSecurity(child, node, issues);
}

export function prepareStandardJavaScript(source: string): StandardJavaScript {
  let program: Node;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true }) as unknown as Node;
  } catch (error) {
    const parsed = error as Error & { pos?: number; raisedAt?: number };
    const start = parsed.pos ?? 0;
    return { ok: false, issues: [{ message: parsed.message, start, end: Math.max(parsed.raisedAt ?? start + 1, start + 1) }] };
  }

  const issues: JavaScriptIssue[] = [];
  validateSecurity(program, null, issues);
  const body = program.body as Node[];
  const declared: string[] = [];
  const rendered: string[] = [];
  const lastMeaningful = [...body].reverse().find(node => node.type !== "EmptyStatement");

  for (const statement of body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations as Node[]) {
        const identifier = declaration.id as Node;
        if (identifier.type !== "Identifier") {
          issues.push(issue(identifier, "Top-level destructuring is not persistent across notebook cells; assign it inside a function or use named variables."));
          continue;
        }
        const name = String(identifier.name);
        declared.push(name);
        rendered.push(`__scope[${JSON.stringify(name)}] = ${declaration.init ? `(${source.slice((declaration.init as Node).start, (declaration.init as Node).end)})` : "undefined"};`);
      }
    } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      const identifier = statement.id as Node | null;
      if (!identifier || identifier.type !== "Identifier") issues.push(issue(statement, "A top-level function or class needs a name."));
      else {
        const name = String(identifier.name);
        declared.push(name);
        rendered.push(`__scope[${JSON.stringify(name)}] = (${source.slice(statement.start, statement.end)});`);
      }
    } else if (statement === lastMeaningful && statement.type === "ExpressionStatement") {
      const expression = statement.expression as Node;
      rendered.push(`return (${source.slice(expression.start, expression.end)});`);
    } else if (statement.type !== "EmptyStatement") {
      rendered.push(source.slice(statement.start, statement.end));
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, executable: `with (__scope) {\n${rendered.join("\n")}\n}`, declared };
}

export function diagnoseStandardJavaScript(source: string): JavaScriptIssue[] {
  const prepared = prepareStandardJavaScript(source);
  return prepared.ok ? [] : prepared.issues;
}

function isBioLangResultEnvelope(value: unknown): value is BioLangResultEnvelope {
  return Boolean(value && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean" &&
    ("value" in value || "error" in value || "structured" in value || "results" in value));
}

function structuredValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as { value?: unknown; columns?: unknown; rows?: unknown };
  if (Array.isArray(item.columns) && Array.isArray(item.rows)) {
    const columns = item.columns as unknown[];
    return item.rows.map(row => Object.fromEntries(columns.map((column, index) => [String(column), Array.isArray(row) ? row[index] : undefined])));
  }
  return "value" in item ? item.value : value;
}

function scalarBioLangValue(value: unknown, type: unknown): unknown {
  if (value === null || value === undefined || type === "Nil") return null;
  if (typeof value !== "string") return value;
  const normalizedType = String(type ?? "").toLowerCase();
  if (normalizedType === "str" || normalizedType === "string") return value;
  if (["int", "integer", "float", "number"].includes(normalizedType)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (["bool", "boolean"].includes(normalizedType)) return value.toLowerCase() === "true";
  try { return JSON.parse(value); }
  catch { return value; }
}

/** Turn nested `bl.*` run envelopes into values suitable for a JS object/table. */
export function normalizeStandardJavaScriptOutput(value: unknown): unknown {
  if (isBioLangResultEnvelope(value)) {
    if (!value.ok) throw new Error(String(value.error ?? "BioLang computation failed."));
    const result = value.results?.length === 1 ? value.results[0]
      : value.results?.length ? value.results
        : value.structured ?? value.value;
    return normalizeStandardJavaScriptOutput(result === value.value ? scalarBioLangValue(result, value.type) : structuredValue(result));
  }
  if (Array.isArray(value)) return value.map(normalizeStandardJavaScriptOutput);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStandardJavaScriptOutput(item)]));
    }
  }
  return value;
}
