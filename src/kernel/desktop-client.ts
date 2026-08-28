import type { AttachedFile, ExecutionResult, Kernel, KernelCapabilities, NativeFileReference, NativeRemoteRequest, NativeRemoteResult, RuntimeInfo, VariableExport, VariableExportFormat, VariablePage, VariableSummary } from "./protocol";

declare global {
  interface Window {
    __BIOLANG_DESKTOP__?: { invoke<T>(command: string, payload?: unknown): Promise<T> };
  }
}

export function desktopAvailable() { return Boolean(window.__BIOLANG_DESKTOP__); }

interface ConsoleResponse {
  status: "ok" | "error";
  output: string;
  error?: string;
  durationMs: number;
  value?: { kind: string; typeName: string; text: string; columns: string[]; rows: string[][]; sequence?: string; truncated: boolean };
  environment: { variables: VariableSummary[]; totalBytes: number };
}

interface NativeExportResponse { path: string; bytes: number }
interface DesktopEnvironment { blVersion?: string; platform?: string; architecture?: string }

export class DesktopKernel implements Kernel {
  readonly capabilities: KernelCapabilities = {
    kind: "desktop", persistent: true, localFiles: true, largeFiles: true,
    remote: false, cancel: true, variableInspection: false, variableRemoval: false, variableExport: "streaming",
    description: "Native BioLang with private notebook files and streaming disk I/O"
  };
  constructor(private readonly namespace: string) {}
  private invoke<T>(command: string, payload?: unknown) {
    if (!window.__BIOLANG_DESKTOP__) throw new Error("BioLang Desktop bridge is not available.");
    return window.__BIOLANG_DESKTOP__.invoke<T>(command, payload);
  }
  async initialize() { await this.invoke("kernel_initialize", { namespace: this.namespace }); return this.capabilities; }
  async execute(source: string): Promise<ExecutionResult> {
    const response = await this.invoke<ConsoleResponse>("kernel_execute", { namespace: this.namespace, source });
    const result: ExecutionResult = {
      ok: response.status === "ok", output: response.output, error: response.error,
      elapsedMs: response.durationMs, backend: "desktop", type: response.value?.typeName,
      value: response.value?.text,
    };
    if (response.value?.kind === "table") result.results = [{ kind: "table", columns: response.value.columns, rows: response.value.rows, truncated: response.value.truncated }];
    else if (response.value?.kind === "sequence") result.results = [{ kind: "sequence", value: response.value.sequence ?? response.value.text }];
    return result;
  }
  reset() { return this.invoke<void>("kernel_reset", { namespace: this.namespace }); }
  clearFiles() { return this.invoke<void>("kernel_clear_files", { namespace: this.namespace }); }
  attach(file: AttachedFile) { return this.invoke<void>("kernel_attach", { namespace: this.namespace, file }); }
  async listVariables() { return (await this.invoke<ConsoleResponse>("kernel_variables", { namespace: this.namespace })).environment.variables; }
  inspectVariable(_name: string, _offset: number, _limit: number): Promise<VariablePage> {
    return Promise.reject(new Error("Paged variable inspection is not available in this Desktop bridge yet."));
  }
  async exportVariable(name: string, format: VariableExportFormat, _maximumBytes: number): Promise<VariableExport> {
    const result = await this.invoke<NativeExportResponse | null>("kernel_export_variable", { namespace: this.namespace, name, format });
    if (!result) return { filename: `${name}.${format === "text" ? "txt" : format}`, mediaType: "application/octet-stream", cancelled: true };
    return { filename: result.path.split(/[\\/]/).at(-1) ?? name, mediaType: "application/octet-stream", savedPath: result.path, byteLength: result.bytes };
  }
  publishVariable(name: string, format: VariableExportFormat, path: string, _maximumBytes: number) {
    return this.invoke<NativeFileReference>("kernel_publish_variable", { namespace: this.namespace, name, format, path });
  }
  importLocalFiles() { return this.invoke<NativeFileReference[]>("kernel_import_files", { namespace: this.namespace }); }
  fetchRemote(request: NativeRemoteRequest) { return this.invoke<NativeRemoteResult>("kernel_fetch_url", { namespace: this.namespace, request }); }
  hasAttachment(path: string, sha256: string) { return this.invoke<boolean>("kernel_has_attachment", { namespace: this.namespace, path, sha256 }); }
  async runtimeInfo(): Promise<RuntimeInfo> {
    const environment = await this.invoke<DesktopEnvironment>("get_environment");
    return {
      runtime: "desktop", description: this.capabilities.description,
      biolangVersion: environment.blVersion, platform: environment.platform, architecture: environment.architecture,
    };
  }
  cancel() { return this.invoke<void>("kernel_cancel", { namespace: this.namespace }); }
  dispose() { void this.invoke("kernel_dispose", { namespace: this.namespace }); }
}
