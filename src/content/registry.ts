export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";

const CACHE_KEY = "biolang-studio:registry:v1";
const KINDS = new Set(["lesson", "package", "workflow", "tool"]);
const STATUSES = new Set(["preview", "stable", "deprecated", "withdrawn"]);
const RUNTIMES = new Set(["browser", "desktop", "somer"]);

export interface RegistryEntry {
  schema: 1;
  kind: "lesson" | "package" | "workflow" | "tool";
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
  compatibility: { biolang?: string; studio?: string; runtimes: Array<"browser" | "desktop" | "somer"> };
  tags: string[];
  sourceRepository: string;
  licence: string;
  validation: string;
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
      !Array.isArray(entry.tags) || !isHttps(entry.sourceRepository) || !entry.licence || !entry.validation) {
    throw new Error(`Registry entry '${entry.id ?? "unknown"}' is invalid.`);
  }
  return entry as RegistryEntry;
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
