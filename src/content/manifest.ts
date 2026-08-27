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

export interface LessonManifest {
  schema: 1;
  id: string;
  title: string;
  summary: string;
  entry: string;
  runtime: RuntimeRequirement;
  estimatedMemoryMb: number;
  source: { title: string; url: string; note: string };
  datasets: DatasetManifest[];
  validation?: string;
  tags: string[];
}

export interface CatalogEntry {
  id: string;
  title: string;
  summary: string;
  manifest: string;
  runtime: RuntimeRequirement;
  tags: string[];
  manifestSha256?: string;
}

export function validateManifest(value: unknown): LessonManifest {
  const manifest = value as Partial<LessonManifest>;
  if (manifest.schema !== 1 || !manifest.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id) ||
      !manifest.title || typeof manifest.summary !== "string" || !manifest.entry ||
      !["browser", "desktop", "remote"].includes(manifest.runtime ?? "") ||
      !manifest.source?.title || !/^https:\/\//.test(manifest.source.url) ||
      !Array.isArray(manifest.datasets) || !Array.isArray(manifest.tags)) {
    throw new Error("Lesson manifest is missing required schema-1 fields.");
  }
  const paths = new Set<string>();
  for (const dataset of manifest.datasets) {
    if (!dataset.id || !dataset.path || dataset.path.startsWith("/") || dataset.path.split(/[\\/]/).includes("..") ||
        paths.has(dataset.path) || !/^https:\/\//.test(dataset.url) || !dataset.title || !dataset.mediaType ||
        !dataset.source || !dataset.citation || !dataset.rights ||
        !/^[a-f0-9]{64}$/i.test(dataset.sha256) || !Number.isInteger(dataset.bytes) || dataset.bytes <= 0) {
      throw new Error(`Dataset '${dataset.id || "unknown"}' has an invalid manifest.`);
    }
    paths.add(dataset.path);
  }
  return manifest as LessonManifest;
}
