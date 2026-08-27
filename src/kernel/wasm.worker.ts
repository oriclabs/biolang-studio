import type { AttachedFile, ExecutionResult, WorkerRequest, WorkerResponse } from "./protocol";

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init: () => void;
  evaluate: (source: string) => string;
  reset: () => void;
  list_variables: () => string;
};

const files = new Map<string, string>();
let runtime: WasmModule | null = null;

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
  const runtimeUrl = new URL("../runtime/bl_wasm.js", self.location.href).href;
  const module = await import(/* @vite-ignore */ runtimeUrl) as WasmModule;
  await module.default(new URL("../runtime/bl_wasm_bg.wasm", self.location.href));
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
  const wasm = await loadRuntime();
  switch (request.method) {
    case "initialize":
      return {
        kind: "browser", persistent: true, localFiles: true, largeFiles: false,
        remote: false, cancel: true,
        description: "BioLang WebAssembly in a dedicated browser worker"
      };
    case "execute": {
      const started = performance.now();
      const result = JSON.parse(wasm.evaluate(request.source)) as ExecutionResult & { structured?: unknown };
      if (!result.ok && /operation not supported|cannot open/i.test(result.error ?? "")) {
        result.error = `${result.error}\nAttached browser files: ${[...new Set(files.keys())].join(", ") || "none"}`;
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
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  let response: WorkerResponse;
  try { response = { id: event.data.id, ok: true, value: await handle(event.data) }; }
  catch (error) { response = { id: event.data.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(response);
};
