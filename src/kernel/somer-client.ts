import type { AttachedFile, ExecutionResult, Kernel, KernelCapabilities, VariableExport, VariableExportFormat, VariablePage } from "./protocol";

interface SomerJob {
  id: string;
  status: "staging" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stdout?: string;
  stderr?: string;
  error?: string;
  results?: unknown[];
}

export class SomerKernel implements Kernel {
  readonly capabilities: KernelCapabilities = {
    kind: "somer", persistent: false, localFiles: true, largeFiles: true,
    remote: true, cancel: true, variableInspection: false, variableRemoval: false, variableExport: "none",
    description: "Remote BioLang execution through the SOMER v1 API"
  };
  private files = new Map<string, AttachedFile>();
  private activeJob: string | null = null;
  private disposed = false;

  constructor(private readonly endpoint: string, private readonly token: string) {}

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.body instanceof Blob ? {} : { "Content-Type": "application/json" }), ...init.headers }
    });
    if (!response.ok) throw new Error(`SOMER ${response.status}: ${await response.text()}`);
    return response;
  }

  async initialize() {
    await this.request("/v1/jobs?limit=1");
    return this.capabilities;
  }
  attach(file: AttachedFile) { this.files.set(file.path, file); return Promise.resolve(); }
  // SOMER jobs are stateless; attached inputs remain staged for the next job.
  reset() { return Promise.resolve(); }
  clearFiles() { this.files.clear(); return Promise.resolve(); }
  listVariables() { return Promise.resolve([]); }
  inspectVariable(_name: string, _offset: number, _limit: number): Promise<VariablePage> {
    return Promise.reject(new Error("SOMER jobs are stateless and do not expose an interactive variable environment."));
  }
  exportVariable(_name: string, _format: VariableExportFormat, _maximumBytes: number): Promise<VariableExport> {
    return Promise.reject(new Error("Export remote job results through a declared SOMER output file."));
  }
  runtimeInfo() {
    return Promise.resolve({ runtime: "somer" as const, description: this.capabilities.description, endpoint: this.endpoint });
  }

  async execute(source: string): Promise<ExecutionResult> {
    const started = performance.now();
    const inputFiles = [...this.files.values()].map(file => ({ path: file.path, size: file.size, sha256: file.sha256 }));
    const submitted = await this.request("/v1/jobs", { method: "POST", body: JSON.stringify({
      executor: "biolang", name: "BioLang Studio cell", entrypoint: "main.bl", source, inputFiles
    }) });
    let job = await submitted.json() as SomerJob;
    this.activeJob = job.id;
    for (const file of this.files.values()) {
      await this.request(`/v1/jobs/${job.id}/inputs/${file.path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT", body: new Blob([file.contents], { type: "text/plain" }), headers: { "Content-Range": `bytes 0-${file.size - 1}/${file.size}` }
      });
    }
    if (this.files.size) await this.request(`/v1/jobs/${job.id}/inputs:complete`, { method: "POST", body: "{}" });
    while (!this.disposed && ["staging", "queued", "running"].includes(job.status)) {
      await new Promise(resolve => setTimeout(resolve, 500));
      job = await (await this.request(`/v1/jobs/${job.id}`)).json() as SomerJob;
    }
    this.activeJob = null;
    return {
      ok: job.status === "succeeded", output: job.stdout, error: job.error || job.stderr,
      results: (job.results ?? []) as never[], elapsedMs: Math.round(performance.now() - started), backend: "somer"
    };
  }
  async cancel() {
    if (this.activeJob) await this.request(`/v1/jobs/${this.activeJob}/cancel`, { method: "POST", body: "{}" });
  }
  dispose() { this.disposed = true; void this.cancel(); }
}
