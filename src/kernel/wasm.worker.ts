import type { AttachedFile, ExecutionResult, VariableExportFormat, WorkerRequest, WorkerResponse } from "./protocol";

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init: () => void;
  evaluate: (source: string) => string;
  reset: () => void;
  list_variables: () => string;
  inspect_variable: (name: string, offset: number, limit: number) => string;
  export_variable: (name: string, format: VariableExportFormat, maximumBytes: number) => Uint8Array;
};

const files = new Map<string, string>();
let runtime: WasmModule | null = null;
let runtimeBase = "";

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
    case "reset":
      wasm.reset();
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
