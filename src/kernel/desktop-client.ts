import type { AttachedFile, ExecutionResult, Kernel, KernelCapabilities } from "./protocol";

declare global {
  interface Window {
    __BIOLANG_DESKTOP__?: { invoke<T>(command: string, payload?: unknown): Promise<T> };
  }
}

export function desktopAvailable() { return Boolean(window.__BIOLANG_DESKTOP__); }

export class DesktopKernel implements Kernel {
  readonly capabilities: KernelCapabilities = {
    kind: "desktop", persistent: true, localFiles: true, largeFiles: true,
    remote: false, cancel: true, description: "Native BioLang through the optional desktop bridge"
  };
  private invoke<T>(command: string, payload?: unknown) {
    if (!window.__BIOLANG_DESKTOP__) throw new Error("BioLang Desktop bridge is not available.");
    return window.__BIOLANG_DESKTOP__.invoke<T>(command, payload);
  }
  async initialize() { await this.invoke("kernel_initialize"); return this.capabilities; }
  execute(source: string) { return this.invoke<ExecutionResult>("kernel_execute", { source }); }
  reset() { return this.invoke<void>("kernel_reset"); }
  clearFiles() { return this.invoke<void>("kernel_clear_files"); }
  attach(file: AttachedFile) { return this.invoke<void>("kernel_attach", { file }); }
  listVariables() { return this.invoke<unknown[]>("kernel_variables"); }
  cancel() { return this.invoke<void>("kernel_cancel"); }
  dispose() { void this.invoke("kernel_dispose"); }
}
