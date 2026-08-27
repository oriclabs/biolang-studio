import type { AttachedFile, ExecutionResult, Kernel, KernelCapabilities, WorkerRequest, WorkerResponse } from "./protocol";

type WorkerCall =
  | { method: "initialize" }
  | { method: "execute"; source: string }
  | { method: "reset" }
  | { method: "clearFiles" }
  | { method: "attach"; file: AttachedFile }
  | { method: "listVariables" };

export class WasmKernel implements Kernel {
  readonly capabilities: KernelCapabilities = {
    kind: "browser", persistent: true, localFiles: true, largeFiles: false,
    remote: false, cancel: true, description: "BioLang WebAssembly in a dedicated browser worker"
  };
  private worker: Worker | null = null;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private attached = new Map<string, AttachedFile>();

  private ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL("./wasm.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const waiter = this.pending.get(event.data.id);
      if (!waiter) return;
      this.pending.delete(event.data.id);
      event.data.ok ? waiter.resolve(event.data.value) : waiter.reject(new Error(event.data.error));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "The browser kernel stopped unexpectedly.");
      this.pending.forEach(waiter => waiter.reject(error));
      this.pending.clear();
    };
  }

  private call<T>(request: WorkerCall): Promise<T> {
    this.ensureWorker();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker!.postMessage({ id, ...request } as WorkerRequest);
    });
  }

  async initialize() {
    const capabilities = await this.call<KernelCapabilities>({ method: "initialize" });
    for (const file of this.attached.values()) await this.call({ method: "attach", file });
    return capabilities;
  }
  execute(source: string) { return this.call<ExecutionResult>({ method: "execute", source }); }
  reset() { return this.call<void>({ method: "reset" }); }
  async clearFiles() { this.attached.clear(); await this.call<void>({ method: "clearFiles" }); }
  async attach(file: AttachedFile) { this.attached.set(file.path, file); await this.call({ method: "attach", file }); }
  listVariables() { return this.call<unknown[]>({ method: "listVariables" }); }
  async cancel() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(waiter => waiter.reject(new Error("Execution cancelled; the browser kernel was restarted.")));
    this.pending.clear();
    await this.initialize();
  }
  dispose() { this.worker?.terminate(); this.worker = null; this.pending.clear(); }
}
