export type LessonLaunchRequest =
  | { kind: "registry"; id: string; version: string }
  | { kind: "manifest"; manifest: string; sha256?: string };

const REGISTRY_ID = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export function parseLessonLaunchUrl(rawUrl: string): LessonLaunchRequest | null {
  const url = new URL(rawUrl);
  const lesson = url.searchParams.get("lesson")?.trim();
  const manifest = url.searchParams.get("manifest")?.trim();
  if (lesson && manifest) throw new Error("A lesson link cannot contain both 'lesson' and 'manifest'.");
  if (lesson) {
    const separator = lesson.lastIndexOf("@");
    const id = lesson.slice(0, separator);
    const version = lesson.slice(separator + 1);
    if (separator < 1 || !REGISTRY_ID.test(id) || !VERSION.test(version)) {
      throw new Error("Registry lesson links must use publisher/name@version.");
    }
    return { kind: "registry", id, version };
  }
  if (manifest) {
    const sha256 = url.searchParams.get("sha256")?.trim();
    if (sha256 && !SHA256.test(sha256)) throw new Error("A direct lesson checksum must be 64 hexadecimal SHA-256 characters.");
    return { kind: "manifest", manifest, ...(sha256 ? { sha256: sha256.toLowerCase() } : {}) };
  }
  return null;
}

function cleanStudioUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  url.search = "";
  url.hash = "";
  return url;
}

export function registryLessonShareUrl(rawUrl: string, id: string, version: string) {
  if (!REGISTRY_ID.test(id) || !VERSION.test(version)) throw new Error("Cannot share an invalid registry lesson identity.");
  const url = cleanStudioUrl(rawUrl);
  url.searchParams.set("lesson", `${id}@${version}`);
  return url.href;
}

export function manifestLessonShareUrl(rawUrl: string, manifest: string, sha256?: string) {
  if (sha256 && !SHA256.test(sha256)) throw new Error("Cannot share an invalid lesson checksum.");
  const url = cleanStudioUrl(rawUrl);
  url.searchParams.set("manifest", manifest);
  if (sha256) url.searchParams.set("sha256", sha256.toLowerCase());
  return url.href;
}

export function removeLessonLaunchParams(rawUrl: string) {
  const url = new URL(rawUrl);
  ["lesson", "manifest", "sha256", "run", "autorun"].forEach(key => url.searchParams.delete(key));
  return url.href;
}
