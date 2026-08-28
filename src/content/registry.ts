export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";

const CACHE_KEY = "biolang-studio:registry:v1";
const KINDS = new Set(["lesson", "package", "workflow", "tool", "dataset", "provider"]);
const STATUSES = new Set(["preview", "stable", "deprecated", "withdrawn"]);
const RUNTIMES = new Set(["browser", "desktop", "somer", "cli"]);

export type RegistryKind = "lesson" | "package" | "workflow" | "tool" | "dataset" | "provider";

export interface DatasetDiscovery {
  provider: string;
  access: "public" | "registration" | "controlled";
  formats: string[];
  modalities: string[];
  organisms: string[];
  fileCount: number;
  totalBytes: number;
}

export interface ProviderDiscovery {
  adapter: string;
  authentication: "none" | "api-key" | "oauth" | "controlled";
  capabilities: string[];
  apiDocumentation: string;
}

export interface RegistryEntry {
  schema: 1;
  kind: RegistryKind;
  id: string;
  name: string;
  title: string;
  summary: string;
  publisher: string;
  version: string;
  status: "preview" | "stable" | "deprecated" | "withdrawn";
  verified: boolean;
  manifest: string;
  manifestSha256: string;
  publishedAt: string;
  compatibility: { biolang?: string; studio?: string; runtimes: Array<"browser" | "desktop" | "somer" | "cli"> };
  categories: string[];
  tags: string[];
  sourceRepository: string;
  licence: string;
  validation: string;
  dataset?: DatasetDiscovery;
  provider?: ProviderDiscovery;
}

export interface RegisteredDatasetFile {
  id: string;
  title: string;
  path: string;
  url: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  format: string;
  compression?: string;
  role: string;
  reader: string;
}

export interface RegisteredDatasetManifest {
  schema: 1;
  kind: "dataset";
  id: string;
  version: string;
  title: string;
  summary: string;
  description: string;
  categories: string[];
  tags: string[];
  modalities: string[];
  organisms: string[];
  provider: string;
  access: { kind: "public" | "registration" | "controlled"; requiresAcceptance: boolean; termsUrl?: string };
  source: { accession?: string; landingPage: string; citation: string; licence: string; rights: string };
  files: RegisteredDatasetFile[];
}

export interface RegistryIndex { schema: 1; entries: RegistryEntry[] }
export type RegistrySource = "network" | "cache";

function isHttps(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("https://");
}

function validateEntry(value: unknown): RegistryEntry {
  if (!value || typeof value !== "object") throw new Error("Registry contains a non-object entry.");
  const entry = value as Partial<RegistryEntry>;
  if (entry.schema !== 1 || !entry.kind || !KINDS.has(entry.kind) ||
      !entry.publisher || !entry.name || entry.id !== `${entry.publisher}/${entry.name}` ||
      !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(entry.id ?? "") ||
      !entry.title || typeof entry.summary !== "string" ||
      !entry.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
      !entry.status || !STATUSES.has(entry.status) || typeof entry.verified !== "boolean" ||
      !isHttps(entry.manifest) || !/^[a-f0-9]{64}$/.test(entry.manifestSha256 ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.publishedAt ?? "") ||
      !entry.compatibility || !Array.isArray(entry.compatibility.runtimes) || !entry.compatibility.runtimes.length ||
      entry.compatibility.runtimes.some(runtime => !RUNTIMES.has(runtime)) ||
      !Array.isArray(entry.categories) || !entry.categories.length || !Array.isArray(entry.tags) ||
      !isHttps(entry.sourceRepository) || !entry.licence || !entry.validation ||
      (entry.kind === "dataset" && (!entry.dataset || !entry.dataset.provider || !Number.isSafeInteger(entry.dataset.totalBytes) || entry.dataset.totalBytes < 1)) ||
      (entry.kind === "provider" && (!entry.provider || !entry.provider.adapter || !isHttps(entry.provider.apiDocumentation)))) {
    throw new Error(`Registry entry '${entry.id ?? "unknown"}' is invalid.`);
  }
  return entry as RegistryEntry;
}

export function searchRegistry(entries: RegistryEntry[], query = "", kind: RegistryKind | "all" = "all", category?: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries.filter(entry => entry.status !== "withdrawn")
    .filter(entry => kind === "all" || entry.kind === kind)
    .filter(entry => !category || entry.categories.includes(category))
    .filter(entry => {
      const text = [entry.id, entry.title, entry.summary, entry.publisher, ...entry.categories, ...entry.tags,
        ...(entry.dataset?.formats ?? []), ...(entry.dataset?.modalities ?? []), ...(entry.dataset?.organisms ?? []),
        ...(entry.provider?.capabilities ?? [])].join(" ").toLowerCase();
      return terms.every(term => text.includes(term));
    });
}

export function validateRegisteredDatasetManifest(value: unknown, entry?: RegistryEntry): RegisteredDatasetManifest {
  if (!value || typeof value !== "object") throw new Error("Dataset manifest must be an object.");
  const manifest = value as Partial<RegisteredDatasetManifest>;
  if (manifest.schema !== 1 || manifest.kind !== "dataset" || !manifest.id || !manifest.version ||
      !manifest.title || !manifest.description || !Array.isArray(manifest.categories) || !Array.isArray(manifest.tags) ||
      !Array.isArray(manifest.modalities) || !Array.isArray(manifest.organisms) || !manifest.provider ||
      !manifest.access || !["public", "registration", "controlled"].includes(manifest.access.kind ?? "") ||
      !manifest.source || !isHttps(manifest.source.landingPage) || !manifest.source.citation || !manifest.source.licence || !manifest.source.rights ||
      !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Dataset manifest is missing required schema-1 fields.");
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const file of manifest.files) {
    if (!file.id || ids.has(file.id) || !file.path || paths.has(file.path) || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..") ||
        !isHttps(file.url) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !file.mediaType || !file.format || !file.role || !/^[a-z_][a-z0-9_]*$/.test(file.reader)) throw new Error(`Dataset file '${file.id || "unknown"}' is invalid.`);
    ids.add(file.id); paths.add(file.path);
  }
  if (entry) {
    const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    if (entry.kind !== "dataset" || manifest.id !== entry.id || manifest.version !== entry.version || !entry.dataset ||
        manifest.provider !== entry.dataset.provider || manifest.access.kind !== entry.dataset.access ||
        manifest.files.length !== entry.dataset.fileCount || total !== entry.dataset.totalBytes) throw new Error("Dataset manifest does not match its registry entry.");
  }
  return manifest as RegisteredDatasetManifest;
}

async function sha256Text(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchRegisteredDataset(entry: RegistryEntry): Promise<RegisteredDatasetManifest> {
  if (entry.kind !== "dataset") throw new Error(`Registry entry '${entry.id}' is not a dataset.`);
  const response = await fetch(entry.manifest, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache" });
  if (!response.ok) throw new Error(`Dataset manifest returned HTTP ${response.status}.`);
  const text = await response.text();
  const actual = await sha256Text(text);
  if (actual.toLowerCase() !== entry.manifestSha256.toLowerCase()) throw new Error("The dataset manifest failed its registry SHA-256 check.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Dataset manifest is not valid JSON."); }
  return validateRegisteredDatasetManifest(value, entry);
}

export function validateRegistry(value: unknown): RegistryIndex {
  if (!value || typeof value !== "object") throw new Error("Registry index must be an object.");
  const index = value as Partial<RegistryIndex>;
  if (index.schema !== 1 || !Array.isArray(index.entries)) throw new Error("Registry index is not schema 1.");
  const entries = index.entries.map(validateEntry);
  const identities = entries.map(entry => `${entry.id}@${entry.version}`);
  if (new Set(identities).size !== identities.length) throw new Error("Registry contains a duplicate entry version.");
  return { schema: 1, entries };
}

export async function fetchRegistry(url = DEFAULT_REGISTRY_URL): Promise<{ index: RegistryIndex; source: RegistrySource }> {
  try {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache" });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
    const text = await response.text();
    const index = validateRegistry(JSON.parse(text));
    localStorage.setItem(CACHE_KEY, text);
    return { index, source: "network" };
  } catch (networkError) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try { return { index: validateRegistry(JSON.parse(cached)), source: "cache" }; }
      catch { localStorage.removeItem(CACHE_KEY); }
    }
    throw networkError;
  }
}
