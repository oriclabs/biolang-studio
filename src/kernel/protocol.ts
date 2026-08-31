export type KernelKind = "browser" | "desktop" | "somer";

export interface KernelCapabilities {
  kind: KernelKind;
  persistent: boolean;
  localFiles: boolean;
  largeFiles: boolean;
  remote: boolean;
  cancel: boolean;
  variableInspection: boolean;
  variableRemoval: boolean;
  variableExport: "capped" | "streaming" | "none";
  description: string;
}

export interface VariableSummary {
  name: string;
  typeName: string;
  preview: string;
  sizeBytes: number;
  sizeApproximate?: boolean;
  length?: number;
  rows?: number;
  columns?: number;
  members: string[];
}

export interface VariablePage {
  name: string;
  typeName: string;
  kind: string;
  offset: number;
  nextOffset: number;
  total: number;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  columnsTruncated: boolean;
}

export type VariableExportFormat = "json" | "csv" | "tsv" | "text";

export interface VariableExport {
  filename: string;
  mediaType: string;
  bytes?: Uint8Array;
  savedPath?: string;
  byteLength?: number;
  cancelled?: boolean;
}

export interface NativeFileReference {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
}

export interface PublishedArtifact extends NativeFileReference {
  bytes?: Uint8Array;
}

export interface NativeRemoteRequest {
  url: string;
  path: string;
  mediaType: string;
  expectedBytes?: number;
  expectedSha256?: string;
}

export interface NativeRemoteResult extends NativeFileReference {
  sourceBytes: number;
  sourceSha256: string;
}

export interface RuntimeInfo {
  runtime: KernelKind;
  description: string;
  biolangVersion?: string;
  platform?: string;
  architecture?: string;
  endpoint?: string;
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
  executeJavaScript?(javascriptSource: string, biolangSource: string): Promise<ExecutionResult>;
  transpileJavaScript?(source: string): Promise<string>;
  reset(): Promise<void>;
  clearFiles(): Promise<void>;
  attach(file: AttachedFile): Promise<void>;
  listVariables(): Promise<VariableSummary[]>;
  inspectVariable(name: string, offset: number, limit: number): Promise<VariablePage>;
  exportVariable(name: string, format: VariableExportFormat, maximumBytes: number): Promise<VariableExport>;
  publishVariable?(name: string, format: VariableExportFormat, path: string, maximumBytes: number): Promise<PublishedArtifact>;
  importLocalFiles?(): Promise<NativeFileReference[]>;
  fetchRemote?(request: NativeRemoteRequest): Promise<NativeRemoteResult>;
  hasAttachment?(path: string, sha256: string): Promise<boolean>;
  runtimeInfo?(): Promise<RuntimeInfo>;
  cancel(): Promise<void>;
  dispose(): void;
}

export type WorkerRequest =
  | { id: number; method: "initialize"; runtimeBase: string }
  | { id: number; method: "execute"; source: string }
  | { id: number; method: "executeJavaScript"; javascriptSource: string; biolangSource: string }
  | { id: number; method: "transpileJavaScript"; source: string }
  | { id: number; method: "reset" }
  | { id: number; method: "clearFiles" }
  | { id: number; method: "attach"; file: AttachedFile }
  | { id: number; method: "listVariables" }
  | { id: number; method: "inspectVariable"; name: string; offset: number; limit: number }
  | { id: number; method: "exportVariable"; name: string; format: VariableExportFormat; maximumBytes: number };

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
