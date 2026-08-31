import type { AttachedFile, ExecutionResult, VariableExportFormat, WorkerRequest, WorkerResponse } from "./protocol";
import { compileSafeJavaScript } from "../notebook/javascript";
import { prepareStandardJavaScript } from "../notebook/standard-javascript";

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init: () => void;
  evaluate: (source: string) => string;
  transpile_javascript: (source: string) => string;
  language_diagnostics: (source: string) => string;
  language_completions: (prefix: string) => string;
  reset: () => void;
  list_variables: () => string;
  inspect_variable: (name: string, offset: number, limit: number) => string;
  export_variable: (name: string, format: VariableExportFormat, maximumBytes: number) => Uint8Array;
};

const files = new Map<string, string>();
let runtime: WasmModule | null = null;
type JavaScriptSdk = {
  sourceOf(value: unknown): string;
  BioLangSession: new (wasm: WasmModule) => StandardBioLangSession;
  [name: string]: unknown;
};
type StandardBioLangSession = {
  run(source: unknown): ExecutionResult;
  reset(): void;
  variables(): Array<{ name?: string }>;
  exportVariable(name: string, options?: { format?: string; maximumBytes?: number }): Uint8Array;
  [name: string]: unknown;
};
let javascriptSdk: JavaScriptSdk | null = null;
let standardSession: StandardBioLangSession | null = null;
let runtimeBase = "";
const javascriptVariables = new Map<string, unknown>();
const standardJavaScriptScope: Record<string, unknown> = Object.create(null);

// wasm-bindgen currently imports the file bridge from `window`. A worker has no
// Window object, so expose the worker global under that name before loading WASM.
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as typeof globalThis & { __blFetch?: unknown }).__blFetch = {
  sync(requested: unknown) {
    const raw = String(requested ?? "");
    const clean = decodeURIComponent(raw.split(/[?#]/)[0]);
    const basename = clean.split(/[\\/]/).at(-1) ?? clean;
    return files.get(raw) ?? files.get(clean) ?? files.get(basename) ??
      `ERROR:File '${raw}' is not attached. Prepare the lesson data or attach the file first.`;
  }
};

async function loadRuntime() {
  if (runtime) return runtime;
  if (!runtimeBase) throw new Error("The browser runtime location was not initialized.");
  const runtimeUrl = new URL("bl_wasm.js", runtimeBase).href;
  const module = await import(/* @vite-ignore */ runtimeUrl) as WasmModule;
  await module.default(new URL("bl_wasm_bg.wasm", runtimeBase));
  module.init();
  runtime = module;
  return module;
}

async function loadJavaScriptSdk() {
  if (javascriptSdk) return javascriptSdk;
  const [dsl, session] = await Promise.all([
    import(/* @vite-ignore */ new URL("biolang-dsl.js", runtimeBase).href),
    import(/* @vite-ignore */ new URL("session.js", runtimeBase).href),
  ]);
  javascriptSdk = { ...dsl, ...session } as JavaScriptSdk;
  return javascriptSdk;
}

async function loadStandardSession(wasm: WasmModule) {
  if (standardSession) return standardSession;
  const sdk = await loadJavaScriptSdk();
  standardSession = new sdk.BioLangSession(wasm);
  return standardSession;
}

function exportedJavaScriptValue(wasm: WasmModule, name: string): unknown {
  const bytes = wasm.export_variable(name, "json", 64 * 1024 * 1024);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function hydrateStandardScope(wasm: WasmModule, names?: Iterable<string>) {
  const requested = names ?? (JSON.parse(wasm.list_variables()) as Array<{ name?: string }>).flatMap(item => item.name ? [item.name] : []);
  for (const name of requested) {
    try { standardJavaScriptScope[name] = exportedJavaScriptValue(wasm, name); }
    catch { /* Functions and opaque runtime objects remain available only through bl. */ }
  }
}

function displayJavaScriptValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

async function executeStandardJavaScript(wasm: WasmModule, source: string): Promise<ExecutionResult> {
  const started = performance.now();
  const prepared = prepareStandardJavaScript(source);
  if (!prepared.ok) return {
    ok: false, error: prepared.issues.map(item => item.message).join("\n"), output: "",
    elapsedMs: Math.round((performance.now() - started) * 10) / 10, backend: "browser",
  };
  hydrateStandardScope(wasm);
  const bl = await loadStandardSession(wasm);
  const sdk = await loadJavaScriptSdk();
  const output: string[] = [];
  const render = (values: unknown[]) => values.map(displayJavaScriptValue).join(" ");
  const consoleBridge = {
    log: (...values: unknown[]) => output.push(render(values)),
    info: (...values: unknown[]) => output.push(render(values)),
    warn: (...values: unknown[]) => output.push(`Warning: ${render(values)}`),
    error: (...values: unknown[]) => output.push(`Error: ${render(values)}`),
  };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const run = new AsyncFunction("__scope", "bl", "bio", "console", prepared.executable);
    const value = await run(standardJavaScriptScope, bl, sdk, consoleBridge);
    const packageResult = value && typeof value === "object" && "ok" in value && ("value" in value || "error" in value)
      ? value as ExecutionResult : null;
    if (packageResult) {
      return {
        ...packageResult, output: [...output, packageResult.output ?? ""].filter(Boolean).join("\n"),
        compiledSource: source, elapsedMs: Math.round((performance.now() - started) * 10) / 10, backend: "browser",
      };
    }
    return {
      ok: true, value: displayJavaScriptValue(value), type: Array.isArray(value) ? "List" : value === null ? "Nil" : typeof value,
      output: output.join("\n"), compiledSource: source,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10, backend: "browser",
    };
  } catch (error) {
    return {
      ok: false, error: error instanceof Error ? error.message : String(error), output: output.join("\n"), compiledSource: source,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10, backend: "browser",
    };
  }
}

function attach(file: AttachedFile) {
  const basename = file.path.split(/[\\/]/).at(-1) ?? file.path;
  files.set(file.path, file.contents);
  files.set(basename, file.contents);
}

async function handle(request: WorkerRequest): Promise<unknown> {
  if (request.method === "initialize") runtimeBase = request.runtimeBase;
  const wasm = await loadRuntime();
  switch (request.method) {
    case "initialize":
      return {
        kind: "browser", persistent: true, localFiles: true, largeFiles: false,
        remote: false, cancel: true, variableInspection: true, variableRemoval: false, variableExport: "capped",
        description: "BioLang WebAssembly in a dedicated browser worker"
      };
    case "execute": {
      const started = performance.now();
      const result = JSON.parse(wasm.evaluate(request.source)) as ExecutionResult & { structured?: unknown };
      if (!result.ok && /operation not supported|cannot open/i.test(result.error ?? "")) {
        const attached = [...new Set(files.keys())];
        result.error = `${result.error}\nAttached browser files: ${attached.join(", ") || "none"}${attached.length ? "" : "\nHint: open Data and choose Prepare for lesson data, or Attach for your own file."}`;
      }
      if (result.structured && !result.results?.length) result.results = [result.structured as never];
      result.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
      result.backend = "browser";
      return result;
    }
    case "executeJavaScript": {
      const started = performance.now();
      const generated = JSON.parse(wasm.transpile_javascript(request.biolangSource)) as { ok: boolean; source?: string; error?: string };
      if (!generated.ok || !generated.source) throw new Error(generated.error || "Cannot translate this cell to JavaScript.");
      const bio = await loadJavaScriptSdk();
      const exactGenerated = generated.source === request.javascriptSource;
      const directSource = generated.source.startsWith("// Direct JavaScript API;");
      const safe = compileSafeJavaScript(request.javascriptSource, javascriptVariables.keys());
      if (safe?.ok) {
        const result = JSON.parse(wasm.evaluate(safe.biolangSource)) as ExecutionResult;
        result.compiledSource = safe.biolangSource;
        result.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
        result.backend = "browser";
        if (result.ok) {
          const bio = await loadJavaScriptSdk();
          for (const name of safe.bindingNames) javascriptVariables.set(name, (bio.ref as (name: string) => unknown)(name));
          hydrateStandardScope(wasm, safe.bindingNames);
        }
        return result;
      }
      if (!exactGenerated || directSource) return executeStandardJavaScript(wasm, request.javascriptSource);
      const priorBindings = [...javascriptVariables.entries()];
      const executable = request.javascriptSource.replace(/\nresult;\s*$/, "\nreturn result;");
      const run = new Function(
        "bio", "bl", ...priorBindings.map(([name]) => name),
        `"use strict"; return (async () => { ${executable} })()`,
      );
      const wrapExpression = (expression: unknown): unknown => {
        if (!expression || typeof expression !== "object" || typeof (expression as { toBioLang?: unknown }).toBioLang !== "function") return expression;
        return new Proxy(expression as Record<PropertyKey, unknown>, {
          get(target, property, receiver) {
            if (property === "then") return undefined;
            if (property === "source" || property === "children" || property === "toBioLang" || typeof property === "symbol") {
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return wrapExpression((bio.field as (object: unknown, name: string) => unknown)(target, String(property)));
          },
        });
      };
      const direct = {
        run(program: unknown) { return JSON.parse(wasm.evaluate(bio.sourceOf(program))) as ExecutionResult; },
        define(name: string, value: unknown) {
          const result = this.run((bio.program as (...items: unknown[]) => unknown)((bio.let_ as (name: string, value: unknown) => unknown)(name, value)));
          if (!result.ok) throw new Error(result.error || `Cannot define ${name}`);
          return (bio.ref as (name: string) => unknown)(name);
        },
        ref(name: string) { return wrapExpression((bio.ref as (name: string) => unknown)(name)); },
        invoke(name: string, ...args: unknown[]) { return wrapExpression((bio.call as (name: string, ...args: unknown[]) => unknown)(name, ...args)); },
      };
      const bl = new Proxy(direct, {
        get(target, property) {
          if (property === "then") return undefined;
          if (typeof property !== "string" || property in target) return Reflect.get(target, property, target);
          return (...args: unknown[]) => wrapExpression((bio.call as (name: string, ...args: unknown[]) => unknown)(property, ...args));
        },
      });
      const result = await run(bio, bl, ...priorBindings.map(([, binding]) => binding)) as ExecutionResult;
      result.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
      result.backend = "browser";
      return result;
    }
    case "compileJavaScript": {
      const safe = compileSafeJavaScript(request.javascriptSource, request.priorNames);
      if (!safe.ok) {
        const standard = prepareStandardJavaScript(request.javascriptSource);
        if (!standard.ok) throw new Error(standard.issues.map(item => item.message).join("\n"));
        return { syncable: false, reason: "This cell uses ordinary JavaScript and remains JavaScript-owned." };
      }
      return { syncable: true, biolangSource: safe.biolangSource };
    }
    case "transpileJavaScript": {
      const result = JSON.parse(wasm.transpile_javascript(request.source)) as { ok: boolean; source?: string; error?: string };
      if (!result.ok || !result.source) throw new Error(result.error || "Cannot translate this cell to JavaScript.");
      return result.source;
    }
    case "diagnostics":
      return JSON.parse(wasm.language_diagnostics(request.source));
    case "completions":
      return JSON.parse(wasm.language_completions(request.prefix));
    case "reset":
      wasm.reset();
      javascriptVariables.clear();
      for (const name of Object.keys(standardJavaScriptScope)) delete standardJavaScriptScope[name];
      standardSession = null;
      return null;
    case "clearFiles":
      files.clear();
      return null;
    case "attach":
      attach(request.file);
      return null;
    case "listVariables":
      return JSON.parse(wasm.list_variables());
    case "inspectVariable": {
      const envelope = JSON.parse(wasm.inspect_variable(request.name, request.offset, request.limit)) as { ok: boolean; page?: unknown; error?: string };
      if (!envelope.ok || !envelope.page) throw new Error(envelope.error || `Cannot inspect ${request.name}.`);
      return envelope.page;
    }
    case "exportVariable": {
      const bytes = wasm.export_variable(request.name, request.format, request.maximumBytes);
      const mediaTypes = { json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values", text: "text/plain" } as const;
      return { filename: `${request.name}.${request.format === "text" ? "txt" : request.format}`, mediaType: mediaTypes[request.format], bytes };
    }
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  let response: WorkerResponse;
  const transfer: Transferable[] = [];
  try {
    const value = await handle(event.data);
    response = { id: event.data.id, ok: true, value };
    if (event.data.method === "exportVariable" && value && typeof value === "object" && "bytes" in value) {
      const bytes = (value as { bytes: Uint8Array }).bytes;
      transfer.push(bytes.buffer);
    }
  }
  catch (error) { response = { id: event.data.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(response, transfer);
};
