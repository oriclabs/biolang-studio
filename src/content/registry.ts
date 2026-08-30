import { isAllowedContentUrl, isLoopbackUrl } from "./url-policy";
import type { LessonSeries } from "./manifest";

export const PUBLIC_REGISTRY_ROOT = "https://registry.lang.bio/";
const PUBLIC_REGISTRY_URL = `${PUBLIC_REGISTRY_ROOT}v1/index.json`;
export const FALLBACK_REGISTRY_URL = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";
const configuredRegistryUrl = import.meta.env.VITE_BIOLANG_REGISTRY_URL?.trim();
const LOCAL_DEVELOPMENT_REGISTRY_URL = "/__biolang/registry/v1/index.json";
export const DEFAULT_REGISTRY_URL = configuredRegistryUrl || (import.meta.env.DEV ? LOCAL_DEVELOPMENT_REGISTRY_URL : PUBLIC_REGISTRY_URL);
export const REGISTRY_URLS = [...new Set([DEFAULT_REGISTRY_URL, ...(configuredRegistryUrl ? [PUBLIC_REGISTRY_URL] : []), FALLBACK_REGISTRY_URL])];

const CACHE_KEY = "biolang-studio:registry:v1";
const CACHE_SOURCE_KEY = `${CACHE_KEY}:source`;
const CACHE_TIME_KEY = `${CACHE_KEY}:checked-at`;
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

export interface LessonDiscoverability {
  problems: string[];
  methods: string[];
  plots: string[];
  terms: string[];
  aliases: string[];
  functions: string[];
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
  discoverability?: LessonDiscoverability;
  sourceRepository: string;
  licence: string;
  validation: string;
  dataset?: DatasetDiscovery;
  provider?: ProviderDiscovery;
  series?: LessonSeries;
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
export type RegistrySource = "local" | "network" | "fallback" | "cache";
export type RegistryKindFilter = RegistryKind | "all";
export type RegistryAccessFilter = "all" | "public" | "registration" | "controlled";
export type RegistryVerificationFilter = "all" | "verified" | "unverified";
export type RegistrySort = "relevance" | "recent" | "name" | "size";

export interface RegistryFilters {
  query?: string;
  kind?: RegistryKindFilter;
  category?: string;
  runtime?: string;
  access?: RegistryAccessFilter;
  verification?: RegistryVerificationFilter;
  sort?: RegistrySort;
}

export function publicRegistryUrl(filters: RegistryFilters = {}, selectedKey = "") {
  const url = new URL(PUBLIC_REGISTRY_ROOT);
  if (filters.query?.trim()) url.searchParams.set("q", filters.query.trim());
  if (filters.kind && filters.kind !== "all") url.searchParams.set("kind", filters.kind);
  if (selectedKey) url.searchParams.set("entry", selectedKey);
  return url.href;
}

export function compareRegistryVersions(left: string, right: string) {
  const parse = (value: string) => {
    const [base, suffix = ""] = value.split(/-(.*)/s, 2);
    return { numbers: base.split(".").map(Number), suffix };
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  if (!a.suffix && b.suffix) return 1;
  if (a.suffix && !b.suffix) return -1;
  return a.suffix.localeCompare(b.suffix, undefined, { numeric: true });
}

export function latestRegistryEntry(entries: RegistryEntry[], id: string) {
  return entries.filter(entry => entry.id === id && entry.status !== "withdrawn")
    .sort((left, right) => compareRegistryVersions(right.version, left.version))[0];
}

export function registrySearchText(entry: RegistryEntry) {
  return [entry.id, entry.title, entry.summary, entry.publisher, ...entry.categories, ...entry.tags,
    ...Object.values(entry.discoverability ?? {}).flat(),
    entry.dataset?.provider ?? "", ...(entry.dataset?.formats ?? []), ...(entry.dataset?.modalities ?? []), ...(entry.dataset?.organisms ?? []),
    entry.provider?.adapter ?? "", entry.provider?.authentication ?? "", ...(entry.provider?.capabilities ?? []),
    entry.series?.id ?? "", entry.series?.title ?? "", entry.series?.chapter ?? ""]
    .join(" ").toLowerCase();
}

function validateEntry(value: unknown, allowLoopback = false): RegistryEntry {
  if (!value || typeof value !== "object") throw new Error("Registry contains a non-object entry.");
  const entry = value as Partial<RegistryEntry>;
  if (entry.schema !== 1 || !entry.kind || !KINDS.has(entry.kind) ||
      !entry.publisher || !entry.name || entry.id !== `${entry.publisher}/${entry.name}` ||
      !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(entry.id ?? "") ||
      !entry.title || typeof entry.summary !== "string" ||
      !entry.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
      !entry.status || !STATUSES.has(entry.status) || typeof entry.verified !== "boolean" ||
      !isAllowedContentUrl(entry.manifest, allowLoopback) || !/^[a-f0-9]{64}$/.test(entry.manifestSha256 ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.publishedAt ?? "") ||
      !entry.compatibility || !Array.isArray(entry.compatibility.runtimes) || !entry.compatibility.runtimes.length ||
      entry.compatibility.runtimes.some(runtime => !RUNTIMES.has(runtime)) ||
      !Array.isArray(entry.categories) || !entry.categories.length || !Array.isArray(entry.tags) ||
      !isAllowedContentUrl(entry.sourceRepository) || !entry.licence || !entry.validation ||
      (entry.kind === "dataset" && (!entry.dataset || !entry.dataset.provider || !Number.isSafeInteger(entry.dataset.totalBytes) || entry.dataset.totalBytes < 1)) ||
      (entry.kind === "provider" && (!entry.provider || !entry.provider.adapter || !isAllowedContentUrl(entry.provider.apiDocumentation))) ||
      (entry.series && (entry.kind !== "lesson" || !/^[a-z0-9][a-z0-9._-]*$/i.test(entry.series.id) || !entry.series.title ||
        !isAllowedContentUrl(entry.series.url, allowLoopback) || !Number.isInteger(entry.series.order) || entry.series.order < 0 || !entry.series.chapter))) {
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
      const text = registrySearchText(entry);
      return terms.every(term => text.includes(term));
    });
}

function searchScore(entry: RegistryEntry, terms: string[]) {
  if (!terms.length) return 0;
  const id = entry.id.toLowerCase();
  const title = entry.title.toLowerCase();
  const summary = entry.summary.toLowerCase();
  const categories = entry.categories.join(" ").toLowerCase();
  const tags = entry.tags.join(" ").toLowerCase();
  const problems = entry.discoverability?.problems.join(" ").toLowerCase() ?? "";
  const methods = entry.discoverability?.methods.join(" ").toLowerCase() ?? "";
  const plots = entry.discoverability?.plots.join(" ").toLowerCase() ?? "";
  const searchableTerms = [
    ...(entry.discoverability?.terms ?? []), ...(entry.discoverability?.aliases ?? []),
    ...(entry.discoverability?.functions ?? [])
  ].join(" ").toLowerCase();
  const discovery = [entry.dataset?.provider ?? "", ...(entry.dataset?.formats ?? []), ...(entry.dataset?.modalities ?? []), ...(entry.dataset?.organisms ?? []),
    entry.provider?.adapter ?? "", entry.provider?.authentication ?? "", ...(entry.provider?.capabilities ?? []),
    entry.series?.id ?? "", entry.series?.title ?? "", entry.series?.chapter ?? ""].join(" ").toLowerCase();
  return terms.reduce((score, term) => score +
    (title.includes(term) ? 14 : 0) + (problems.includes(term) ? 10 : 0) +
    (methods.includes(term) ? 9 : 0) + (id.includes(term) ? 8 : 0) +
    (plots.includes(term) ? 7 : 0) + (tags.includes(term) ? 6 : 0) +
    (categories.includes(term) ? 5 : 0) + (summary.includes(term) ? 4 : 0) +
    (searchableTerms.includes(term) ? 3 : 0) + (discovery.includes(term) ? 2 : 0), 0);
}

export function filterRegistry(entries: RegistryEntry[], filters: RegistryFilters = {}) {
  const terms = (filters.query ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = searchRegistry(entries, filters.query, filters.kind, filters.category)
    .filter(entry => !filters.runtime || entry.compatibility.runtimes.includes(filters.runtime as RegistryEntry["compatibility"]["runtimes"][number]))
    .filter(entry => !filters.access || filters.access === "all" || entry.dataset?.access === filters.access)
    .filter(entry => !filters.verification || filters.verification === "all" ||
      (filters.verification === "verified" ? entry.verified : !entry.verified));

  return [...filtered].sort((left, right) => {
    if (filters.sort === "name") return left.title.localeCompare(right.title) || right.version.localeCompare(left.version, undefined, { numeric: true });
    if (filters.sort === "size") return (right.dataset?.totalBytes ?? -1) - (left.dataset?.totalBytes ?? -1) || left.title.localeCompare(right.title);
    if (filters.sort === "recent") return right.publishedAt.localeCompare(left.publishedAt) || left.title.localeCompare(right.title);
    const score = searchScore(right, terms) - searchScore(left, terms);
    return score || Number(right.verified) - Number(left.verified) || right.publishedAt.localeCompare(left.publishedAt) || left.title.localeCompare(right.title);
  });
}

export function validateRegisteredDatasetManifest(value: unknown, entry?: RegistryEntry): RegisteredDatasetManifest {
  if (!value || typeof value !== "object") throw new Error("Dataset manifest must be an object.");
  const manifest = value as Partial<RegisteredDatasetManifest>;
  if (manifest.schema !== 1 || manifest.kind !== "dataset" || !manifest.id || !manifest.version ||
      !manifest.title || !manifest.description || !Array.isArray(manifest.categories) || !Array.isArray(manifest.tags) ||
      !Array.isArray(manifest.modalities) || !Array.isArray(manifest.organisms) || !manifest.provider ||
      !manifest.access || !["public", "registration", "controlled"].includes(manifest.access.kind ?? "") ||
      !manifest.source || !isAllowedContentUrl(manifest.source.landingPage) || !manifest.source.citation || !manifest.source.licence || !manifest.source.rights ||
      !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Dataset manifest is missing required schema-1 fields.");
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const file of manifest.files) {
    if (!file.id || ids.has(file.id) || !file.path || paths.has(file.path) || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..") ||
        !isAllowedContentUrl(file.url) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
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

export async function fetchRegisteredDataset(entry: RegistryEntry, signal?: AbortSignal): Promise<RegisteredDatasetManifest> {
  if (entry.kind !== "dataset") throw new Error(`Registry entry '${entry.id}' is not a dataset.`);
  const response = await fetch(entry.manifest, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache", signal });
  if (!response.ok) throw new Error(`Dataset manifest returned HTTP ${response.status}.`);
  const text = await response.text();
  const actual = await sha256Text(text);
  if (actual.toLowerCase() !== entry.manifestSha256.toLowerCase()) throw new Error("The dataset manifest failed its registry SHA-256 check.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Dataset manifest is not valid JSON."); }
  return validateRegisteredDatasetManifest(value, entry);
}

export function validateRegistry(value: unknown, options: { allowLoopback?: boolean } = {}): RegistryIndex {
  if (!value || typeof value !== "object") throw new Error("Registry index must be an object.");
  const index = value as Partial<RegistryIndex>;
  if (index.schema !== 1 || !Array.isArray(index.entries)) throw new Error("Registry index is not schema 1.");
  const entries = index.entries.map(entry => validateEntry(entry, options.allowLoopback));
  const identities = entries.map(entry => `${entry.id}@${entry.version}`);
  if (new Set(identities).size !== identities.length) throw new Error("Registry contains a duplicate entry version.");
  return { schema: 1, entries };
}

export async function fetchRegistry(urls: string[] = REGISTRY_URLS): Promise<{ index: RegistryIndex; source: RegistrySource; checkedAt: string }> {
  let networkError: unknown = new Error("Registry is unavailable.");
  for (const [index, url] of urls.entries()) {
    try {
      const resolvedUrl = new URL(url, location.href);
      if (!isAllowedContentUrl(resolvedUrl.href, isLoopbackUrl(resolvedUrl))) throw new Error("Registry URLs must use HTTPS (HTTP loopback URLs are allowed for local development).");
      const response = await fetch(resolvedUrl, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache" });
      if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
      const text = await response.text();
      const local = isLoopbackUrl(resolvedUrl);
      const registry = validateRegistry(JSON.parse(text), { allowLoopback: local });
      localStorage.setItem(CACHE_KEY, text);
      localStorage.setItem(CACHE_SOURCE_KEY, resolvedUrl.href);
      const checkedAt = new Date().toISOString();
      localStorage.setItem(CACHE_TIME_KEY, checkedAt);
      return { index: registry, source: local ? "local" : resolvedUrl.href === FALLBACK_REGISTRY_URL ? "fallback" : "network", checkedAt };
    } catch (error) { networkError = error; }
  }
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const cachedSource = localStorage.getItem(CACHE_SOURCE_KEY) ?? "";
      const allowLoopback = isLoopbackUrl(cachedSource) && urls.some(url => isLoopbackUrl(new URL(url, location.href)));
      return { index: validateRegistry(JSON.parse(cached), { allowLoopback }), source: "cache", checkedAt: localStorage.getItem(CACHE_TIME_KEY) ?? "" };
    } catch {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_SOURCE_KEY);
      localStorage.removeItem(CACHE_TIME_KEY);
    }
  }
  throw networkError;
}
