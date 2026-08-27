import type { CatalogEntry, DatasetManifest, LessonManifest } from "./manifest";

const STORAGE_KEY = "biolang-studio:installed-lessons:v1";

export type InstalledLesson = CatalogEntry & { manifest: string; installedAt: string; datasets: DatasetManifest[] };

export function installedLessons(): InstalledLesson[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function installLesson(manifest: LessonManifest, manifestUrl: string, manifestSha256?: string): InstalledLesson[] {
  const next: InstalledLesson = {
    id: manifest.id, title: manifest.title, summary: manifest.summary,
    manifest: manifestUrl, runtime: manifest.runtime, tags: manifest.tags,
    installedAt: new Date().toISOString(), datasets: manifest.datasets, manifestSha256
  };
  const lessons = [...installedLessons().filter(item => item.id !== next.id), next];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lessons));
  return lessons;
}

export function uninstallLesson(id: string): InstalledLesson[] {
  const lessons = installedLessons().filter(item => item.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lessons));
  return lessons;
}
