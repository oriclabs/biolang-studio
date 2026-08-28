import type { DatasetManifest, LessonManifest } from "../content/manifest";

export type AttachmentScope = { kind: "workspace" } | { kind: "notebook"; notebookId: string };

export interface WorkspaceAttachment {
  id: string;
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
  scope: AttachmentScope;
  source: { kind: "local" } | { kind: "dataset"; dataset: DatasetManifest } | {
    kind: "url";
    url: string;
    sourceBytes: number;
    sourceSha256: string;
    retrievedAt: string;
  } | {
    kind: "output";
    producerNotebookId: string;
    producerNotebookFilename: string;
    variable: string;
    format: "json" | "csv" | "tsv" | "text";
    createdAt: string;
    executedSourceSha256?: string;
  };
}

export interface StoredNotebook {
  id: string;
  filename: string;
  source: string;
  lesson?: LessonManifest;
  dataReady?: Record<string, boolean>;
  attachmentIds: string[];
}

export interface PortableWorkspace {
  $schema?: string;
  schema: 3;
  kind: "biolang-workspace";
  name: string;
  activeNotebookId: string;
  notebooks: StoredNotebook[];
  attachments: WorkspaceAttachment[];
}

const WORKSPACE_SCHEMA_V1_URL = "https://oriclabs.com/biolang-studio/schemas/biolang-workspace-v1.schema.json";
const WORKSPACE_SCHEMA_V2_URL = "https://oriclabs.com/biolang-studio/schemas/biolang-workspace-v2.schema.json";
export const WORKSPACE_SCHEMA_URL = "https://oriclabs.com/biolang-studio/schemas/biolang-workspace-v3.schema.json";

export function isSafeWorkspacePath(value: string) {
  return Boolean(value) && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..");
}

export function attachmentId(path: string, digest: string) {
  return `${digest.toLowerCase()}:${path}`;
}

export function assertUnambiguousMountPaths(attachments: WorkspaceAttachment[], notebookIds: string[]) {
  const ids = new Set([...notebookIds, ...attachments.flatMap(attachment => attachment.scope.kind === "notebook" ? [attachment.scope.notebookId] : [])]);
  for (const notebookId of ids) {
    const mounted = new Map<string, string>();
    for (const attachment of attachments) {
      if (attachment.scope.kind === "notebook" && attachment.scope.notebookId !== notebookId) continue;
      const previous = mounted.get(attachment.path);
      if (previous && previous !== attachment.sha256.toLowerCase()) throw new Error(`Data path '${attachment.path}' refers to different files in notebook '${notebookId}'. Rename or detach one before mounting it.`);
      mounted.set(attachment.path, attachment.sha256.toLowerCase());
    }
  }
}

function validateWorkspaceVersion(value: unknown, schema: 1 | 2 | 3, schemaUrl: string): PortableWorkspace {
  const workspace = value as Partial<PortableWorkspace>;
  if (workspace.schema !== schema || workspace.kind !== "biolang-workspace" || typeof workspace.name !== "string" || !workspace.name ||
      (workspace.$schema !== undefined && workspace.$schema !== schemaUrl) ||
      !Array.isArray(workspace.notebooks) || !workspace.notebooks.length || !Array.isArray(workspace.attachments)) {
    throw new Error("Workspace file is missing required schema-1 fields.");
  }
  const notebookIds = new Set<string>();
  for (const notebook of workspace.notebooks) {
    if (typeof notebook?.id !== "string" || !notebook.id || notebookIds.has(notebook.id) || !isSafeWorkspacePath(notebook.filename) || typeof notebook.source !== "string" ||
        !Array.isArray(notebook.attachmentIds) || notebook.attachmentIds.some(id => typeof id !== "string" || !id) || new Set(notebook.attachmentIds).size !== notebook.attachmentIds.length) {
      throw new Error("Workspace contains an invalid notebook record.");
    }
    notebookIds.add(notebook.id);
  }
  if (!workspace.activeNotebookId || !notebookIds.has(workspace.activeNotebookId)) throw new Error("Workspace active notebook is invalid.");
  const attachmentIds = new Set<string>();
  for (const attachment of workspace.attachments) {
    if (!attachment?.id || attachmentIds.has(attachment.id) || !isSafeWorkspacePath(attachment.path) || !Number.isSafeInteger(attachment.size) || attachment.size < 0 ||
        !/^[a-f0-9]{64}$/i.test(attachment.sha256) || !attachment.mediaType || !["workspace", "notebook"].includes(attachment.scope?.kind) ||
        (attachment.scope.kind === "notebook" && !notebookIds.has(attachment.scope.notebookId)) || !["local", "dataset", ...(schema >= 2 ? ["url"] : []), ...(schema >= 3 ? ["output"] : [])].includes(attachment.source?.kind)) {
      throw new Error("Workspace contains an invalid data attachment.");
    }
    if (attachment.id !== attachmentId(attachment.path, attachment.sha256)) throw new Error("Workspace data attachment identity is inconsistent.");
    if (attachment.source.kind === "dataset") {
      const dataset = attachment.source.dataset;
      if (!dataset?.id || !dataset.title || dataset.path !== attachment.path || dataset.bytes !== attachment.size || dataset.mediaType !== attachment.mediaType ||
          dataset.sha256.toLowerCase() !== attachment.sha256.toLowerCase() || !/^https:\/\//.test(dataset.url) || !dataset.source || !dataset.citation || !dataset.rights) {
        throw new Error("Workspace dataset reference is inconsistent.");
      }
    } else if (attachment.source.kind === "url") {
      const source = attachment.source;
      if (!/^https:\/\//.test(source.url) || !Number.isSafeInteger(source.sourceBytes) || source.sourceBytes < 0 ||
          !/^[a-f0-9]{64}$/i.test(source.sourceSha256) || typeof source.retrievedAt !== "string" || !Number.isFinite(Date.parse(source.retrievedAt))) {
        throw new Error("Workspace URL data provenance is invalid.");
      }
    } else if (attachment.source.kind === "output") {
      const source = attachment.source;
      if (!source.producerNotebookId || !isSafeWorkspacePath(source.producerNotebookFilename) || !source.variable ||
          !["json", "csv", "tsv", "text"].includes(source.format) || typeof source.createdAt !== "string" || !Number.isFinite(Date.parse(source.createdAt)) ||
          (source.executedSourceSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.executedSourceSha256))) {
        throw new Error("Workspace output provenance is invalid.");
      }
    }
    attachmentIds.add(attachment.id);
  }
  const byId = new Map(workspace.attachments.map(attachment => [attachment.id, attachment]));
  if (workspace.notebooks.some(notebook => notebook.attachmentIds.some(id => {
    const attachment = byId.get(id);
    return !attachment || (attachment.scope.kind === "notebook" && attachment.scope.notebookId !== notebook.id);
  }))) throw new Error("Workspace notebook refers to missing or incorrectly scoped data.");
  assertUnambiguousMountPaths(workspace.attachments, [...notebookIds]);
  return workspace as PortableWorkspace;
}

export function validatePortableWorkspace(value: unknown): PortableWorkspace {
  return validateWorkspaceVersion(value, 3, WORKSPACE_SCHEMA_URL);
}

export function migratePortableWorkspace(value: unknown): PortableWorkspace {
  const candidate = value as { schema?: unknown };
  if (candidate?.schema === 3) return validatePortableWorkspace(value);
  if (candidate?.schema === 1 || candidate?.schema === 2) {
    const legacy = validateWorkspaceVersion(value, candidate.schema, candidate.schema === 1 ? WORKSPACE_SCHEMA_V1_URL : WORKSPACE_SCHEMA_V2_URL);
    return { ...legacy, $schema: WORKSPACE_SCHEMA_URL, schema: 3 };
  }
  if (typeof candidate?.schema === "number" && candidate.schema > 3) throw new Error(`Workspace schema ${candidate.schema} is newer than this Studio. Update Studio before opening it.`);
  throw new Error(`Workspace schema '${String(candidate?.schema ?? "missing")}' is unsupported and has no safe migration.`);
}
