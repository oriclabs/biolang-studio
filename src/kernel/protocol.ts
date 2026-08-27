export type KernelKind = "browser" | "desktop" | "somer";

export interface KernelCapabilities {
  kind: KernelKind;
  persistent: boolean;
  localFiles: boolean;
  largeFiles: boolean;
  remote: boolean;
  cancel: boolean;
  description: string;
}

export interface StructuredResult {
  kind: string;
  format?: string;
  data?: string;
  value?: unknown;
  columns?: string[];
  rows?: unknown[][];
  totalRows?: number;
  truncated?: boolean;
  [key: string]: unknown;
}

export interface ExecutionResult {
  ok: boolean;
  value?: string;
  type?: string;
  output?: string;
  error?: string;
  results?: StructuredResult[];
  trace?: Array<{ line: number; text: string }>;
  elapsedMs?: number;
  backend?: KernelKind;
}

export interface AttachedFile {
  path: string;
  contents: string;
  size: number;
  sha256?: string;
}

export interface Kernel {
  readonly capabilities: KernelCapabilities;
  initialize(): Promise<KernelCapabilities>;
  execute(source: string): Promise<ExecutionResult>;
  reset(): Promise<void>;
  clearFiles(): Promise<void>;
  attach(file: AttachedFile): Promise<void>;
  listVariables(): Promise<unknown[]>;
  cancel(): Promise<void>;
  dispose(): void;
}

export type WorkerRequest =
  | { id: number; method: "initialize" }
  | { id: number; method: "execute"; source: string }
  | { id: number; method: "reset" }
  | { id: number; method: "clearFiles" }
  | { id: number; method: "attach"; file: AttachedFile }
  | { id: number; method: "listVariables" };

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
