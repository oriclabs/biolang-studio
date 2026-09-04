import { isAllowedContentUrl } from "./url-policy";
import type { LessonDiscoverability } from "./registry";

export type RuntimeRequirement = "browser" | "desktop" | "remote";

export interface DatasetManifest {
  id: string;
  title: string;
  path: string;
  url: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  source: string;
  citation: string;
  rights: string;
}

export interface LessonEntry {
  id: string;
  title: string;
  summary: string;
  entry: string;
  discoverability?: LessonDiscoverability;
}

export interface LessonSeries {
  id: string;
  title: string;
  url: string;
  order: number;
  chapter: string;
}

export interface LessonManifest {
  schema: 1 | 2;
  id: string;
  title: string;
  summary: string;
  entry?: string;
  lessons?: LessonEntry[];
  runtime: RuntimeRequirement;
  estimatedMemoryMb: number;
  source: { title: string; url: string; note: string };
  series?: LessonSeries;
  datasets: DatasetManifest[];
  validation?: string;
  tags: string[];
  discoverability?: LessonDiscoverability;
}

function safeEntryPath(path: string) {
  return Boolean(path) && !path.startsWith("/") && !path.startsWith("\\") &&
    !path.split(/[\\/]/).includes("..") && /\.bln$/i.test(path);
}

export function manifestLessonEntries(manifest: LessonManifest): LessonEntry[] {
  if (manifest.schema === 1) {
    return [{ id: manifest.id, title: manifest.title, summary: manifest.summary, entry: manifest.entry! }];
  }
  return manifest.lessons!;
}

export function lessonEntryForDocument(manifest: LessonManifest, filename: string, siblingIndex = 0): LessonEntry {
  const entries = manifestLessonEntries(manifest);
  const basename = filename.replace(/\.bln$/i, "");
  return entries.find(entry => entry.id === basename) ?? entries[siblingIndex] ?? entries[0];
}

export interface CatalogEntry {
  id: string;
  title: string;
  summary: string;
  version?: string;
  manifest: string;
  runtime: RuntimeRequirement;
  tags: string[];
  manifestSha256?: string;
  series?: LessonSeries;
}

// Lesson URLs on moving branches can retain the same URL across Registry
// revisions. Bypass the browser/CDN cache whenever integrity is checked so the
// response bytes are from the revision named by the current Registry checksum.
export function lessonFetchOptions(signal?: AbortSignal): RequestInit {
  return {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  };
}

function validSeries(series: LessonSeries | undefined, allowLoopback = false) {
  return !series || (/^[a-z0-9][a-z0-9._-]*$/i.test(series.id) && Boolean(series.title) &&
    isAllowedContentUrl(series.url, allowLoopback) && Number.isInteger(series.order) && series.order >= 0 &&
    Boolean(series.chapter));
}

export function validateManifest(value: unknown, options: { allowLoopback?: boolean } = {}): LessonManifest {
  const manifest = value as Partial<LessonManifest>;
  if (![1, 2].includes(manifest.schema ?? 0) || !manifest.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id) ||
      !manifest.title || typeof manifest.summary !== "string" ||
      !["browser", "desktop", "remote"].includes(manifest.runtime ?? "") ||
      !manifest.source?.title || !isAllowedContentUrl(manifest.source.url, options.allowLoopback) ||
      !Array.isArray(manifest.datasets) || !Array.isArray(manifest.tags) ||
      !validSeries(manifest.series, options.allowLoopback)) {
    throw new Error("Lesson manifest is missing required fields.");
  }
  if (manifest.schema === 1 && (!manifest.entry || !safeEntryPath(manifest.entry))) {
    throw new Error("A schema-1 lesson must declare one safe .bln entry.");
  }
  if (manifest.schema === 2) {
    if (!Array.isArray(manifest.lessons) || manifest.lessons.length < 2) {
      throw new Error("A schema-2 lesson collection must declare at least two lessons.");
    }
    const ids = new Set<string>();
    const entries = new Set<string>();
    for (const lesson of manifest.lessons) {
      if (!lesson?.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(lesson.id) || ids.has(lesson.id) ||
          !lesson.title || typeof lesson.summary !== "string" || !safeEntryPath(lesson.entry) || entries.has(lesson.entry)) {
        throw new Error(`Lesson collection entry '${lesson?.id || "unknown"}' is invalid or duplicated.`);
      }
      ids.add(lesson.id);
      entries.add(lesson.entry);
    }
  }
  const paths = new Set<string>();
  for (const dataset of manifest.datasets) {
    if (!dataset.id || !dataset.path || dataset.path.startsWith("/") || dataset.path.split(/[\\/]/).includes("..") ||
        paths.has(dataset.path) || !isAllowedContentUrl(dataset.url, options.allowLoopback) || !dataset.title || !dataset.mediaType ||
        !dataset.source || !dataset.citation || !dataset.rights ||
        !/^[a-f0-9]{64}$/i.test(dataset.sha256) || !Number.isInteger(dataset.bytes) || dataset.bytes <= 0) {
      throw new Error(`Dataset '${dataset.id || "unknown"}' has an invalid manifest.`);
    }
    paths.add(dataset.path);
  }
  return manifest as LessonManifest;
}
