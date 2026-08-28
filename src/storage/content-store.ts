import type { AttachedFile } from "../kernel/protocol";
import type { DatasetManifest } from "../content/manifest";

const CACHE_NAME = "biolang-studio-content-v1";

export interface StorageStatus {
  usage: number;
  quota: number;
  persistent: boolean;
}

export interface RemoteAttachmentRequest {
  url: string;
  path: string;
  mediaType: string;
  maximumBytes: number;
  expectedBytes?: number;
  expectedSha256?: string;
}

export interface PreparedRemoteAttachment {
  file: AttachedFile;
  sourceBytes: number;
  sourceSha256: string;
  responseMediaType: string;
}

export async function sha256(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function cache(): Promise<Cache | null> {
  return "caches" in globalThis ? caches.open(CACHE_NAME) : null;
}

export async function storageStatus(): Promise<StorageStatus> {
  const estimate = await navigator.storage?.estimate?.();
  return {
    usage: estimate?.usage ?? 0,
    quota: estimate?.quota ?? 0,
    persistent: await navigator.storage?.persisted?.() ?? false,
  };
}

export async function requestPersistentStorage() {
  return await navigator.storage?.persist?.() ?? false;
}

export async function clearContentCache() {
  if ("caches" in globalThis) await caches.delete(CACHE_NAME);
}

function cacheKey(dataset: DatasetManifest) {
  return new URL(`./__content/${dataset.sha256}/${encodeURIComponent(dataset.path)}`, location.href).href;
}

function attachmentCacheKey(file: Pick<AttachedFile, "path" | "sha256">) {
  if (!file.sha256) throw new Error(`Attachment '${file.path}' has no SHA-256.`);
  return new URL(`./__attachments/${file.sha256}/${encodeURIComponent(file.path)}`, location.href).href;
}

export async function hasDataset(dataset: DatasetManifest) {
  const store = await cache();
  return Boolean(store && await store.match(cacheKey(dataset)));
}

export async function removeDataset(dataset: DatasetManifest) {
  const store = await cache();
  if (store) await store.delete(cacheKey(dataset));
}

export async function prepareDataset(dataset: DatasetManifest, onProgress?: (loaded: number) => void): Promise<AttachedFile> {
  const store = await cache();
  const key = cacheKey(dataset);
  let response = store ? await store.match(key) : undefined;
  if (!response) {
    const downloaded = await fetch(dataset.url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!downloaded.ok) throw new Error(`HTTP ${downloaded.status} downloading ${dataset.title}`);
    const reader = downloaded.body?.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.byteLength; onProgress?.(loaded);
      }
    } else {
      const bytes = new Uint8Array(await downloaded.arrayBuffer());
      chunks.push(bytes); loaded = bytes.byteLength; onProgress?.(loaded);
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (loaded !== dataset.bytes) throw new Error(`${dataset.title} expected ${dataset.bytes} bytes, received ${loaded}.`);
    const actual = await sha256(bytes.buffer);
    if (actual.toLowerCase() !== dataset.sha256.toLowerCase()) throw new Error(`${dataset.title} failed its SHA-256 check.`);
    response = new Response(bytes, { headers: { "content-type": dataset.mediaType, "x-biolang-sha256": actual } });
    if (store) await store.put(key, response.clone());
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== dataset.bytes) throw new Error(`${dataset.title} cached size differs from its manifest.`);
  const actual = await sha256(bytes);
  if (actual.toLowerCase() !== dataset.sha256.toLowerCase()) throw new Error(`${dataset.title} cached content failed its SHA-256 check.`);
  return { path: dataset.path, contents: new TextDecoder().decode(bytes), size: bytes.byteLength, sha256: actual };
}

export async function cacheAttachment(file: AttachedFile) {
  const actual = await sha256(file.contents);
  if (file.sha256 && file.sha256.toLowerCase() !== actual) throw new Error(`${file.path} does not match its declared SHA-256.`);
  const digest = actual;
  const stored = { ...file, sha256: digest };
  const content = await cache();
  if (content) await content.put(attachmentCacheKey(stored), new Response(stored.contents, {
    headers: { "content-type": "text/plain; charset=utf-8", "x-biolang-sha256": digest }
  }));
  return stored;
}

function baseMediaType(value: string | null) {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function textLikeMediaType(value: string) {
  return value.startsWith("text/") || value === "application/json" || value.endsWith("+json") || value === "application/octet-stream";
}

/** Download an explicitly approved HTTPS text resource with a hard streaming cap. */
export async function prepareRemoteAttachment(request: RemoteAttachmentRequest, onProgress?: (loaded: number) => void): Promise<PreparedRemoteAttachment> {
  const parsed = new URL(request.url);
  if (parsed.protocol !== "https:") throw new Error("Remote data URLs must use HTTPS.");
  if (!textLikeMediaType(baseMediaType(request.mediaType))) throw new Error("Browser data must be text, JSON, or an explicitly decoded octet stream.");
  let response: Response;
  try {
    response = await fetch(parsed.href, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw new Error("The browser could not access this URL. The host may not allow cross-origin downloads (CORS), or the network may be unavailable.");
  }
  if (!response.ok) throw new Error(`Remote data returned HTTP ${response.status}.`);
  if (response.url && new URL(response.url).protocol !== "https:") {
    await response.body?.cancel();
    throw new Error("The source redirected to a non-HTTPS location, so Studio refused the download.");
  }
  const reportedLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(reportedLength) && reportedLength > request.maximumBytes) {
    await response.body?.cancel();
    throw new Error(`The source reports ${reportedLength} bytes, above Studio's ${request.maximumBytes}-byte browser limit.`);
  }
  const responseMediaType = baseMediaType(response.headers.get("content-type"));
  if (responseMediaType && !textLikeMediaType(responseMediaType)) {
    await response.body?.cancel();
    throw new Error(`The source returned '${responseMediaType}', which is not browser-safe text data. Use Desktop or SOMER for binary data.`);
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > request.maximumBytes) {
        await reader.cancel();
        throw new Error(`Download exceeded Studio's ${request.maximumBytes}-byte browser limit. Use Desktop or SOMER so the file can stream to disk.`);
      }
      chunks.push(value); onProgress?.(loaded);
    }
  } else {
    const value = new Uint8Array(await response.arrayBuffer());
    loaded = value.byteLength;
    if (loaded > request.maximumBytes) throw new Error(`Download exceeded Studio's ${request.maximumBytes}-byte browser limit. Use Desktop or SOMER.`);
    chunks.push(value); onProgress?.(loaded);
  }
  if (request.expectedBytes !== undefined && loaded !== request.expectedBytes) throw new Error(`Expected ${request.expectedBytes} bytes, but the source returned ${loaded}.`);
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const sourceSha256 = await sha256(bytes.buffer);
  if (request.expectedSha256 && sourceSha256 !== request.expectedSha256.toLowerCase()) throw new Error("Remote data failed its expected SHA-256 check.");
  let contents: string;
  try { contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Remote data is not valid UTF-8 text. Use Desktop or SOMER with a binary-aware reader."); }
  const mountedBytes = new TextEncoder().encode(contents).byteLength;
  const file = await cacheAttachment({ path: request.path, contents, size: mountedBytes });
  return { file, sourceBytes: loaded, sourceSha256, responseMediaType: responseMediaType || baseMediaType(request.mediaType) };
}

export async function loadAttachment(file: Pick<AttachedFile, "path" | "size" | "sha256">): Promise<AttachedFile | null> {
  if (!file.sha256) return null;
  const content = await cache();
  const response = content ? await content.match(attachmentCacheKey(file)) : undefined;
  if (!response) return null;
  const contents = await response.text();
  const actual = await sha256(contents);
  if (actual.toLowerCase() !== file.sha256.toLowerCase()) return null;
  return { path: file.path, size: new TextEncoder().encode(contents).byteLength, sha256: actual, contents };
}

export async function saveWorkspace(name: string, source: string) {
  if (!navigator.storage?.getDirectory) {
    localStorage.setItem(`biolang-studio:${name}`, source);
    return;
  }
  const root = await navigator.storage.getDirectory();
  const workspaces = await root.getDirectoryHandle("workspaces", { create: true });
  const file = await workspaces.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(source); await writable.close();
}

export async function loadWorkspace(name: string) {
  if (!navigator.storage?.getDirectory) return localStorage.getItem(`biolang-studio:${name}`);
  try {
    const root = await navigator.storage.getDirectory();
    const workspaces = await root.getDirectoryHandle("workspaces");
    const file = await workspaces.getFileHandle(name);
    return await (await file.getFile()).text();
  } catch { return null; }
}

const SESSION_FILE = "__studio-session-v1.json";

type SessionEnvelope = { schema: 1; kind: "biolang-studio-session"; savedAt: string; sha256: string; payload: string };

async function readWorkspaceFile(name: string) {
  return loadWorkspace(name);
}

async function removeWorkspaceFile(name: string) {
  if (!navigator.storage?.getDirectory) { localStorage.removeItem(`biolang-studio:${name}`); return; }
  try {
    const root = await navigator.storage.getDirectory();
    const workspaces = await root.getDirectoryHandle("workspaces");
    await workspaces.removeEntry(name);
  } catch { /* Missing temporary files are already clean. */ }
}

async function encodeSession(payload: string): Promise<SessionEnvelope> {
  return { schema: 1, kind: "biolang-studio-session", savedAt: new Date().toISOString(), sha256: await sha256(payload), payload };
}

async function decodeSession(raw: string, allowLegacy: boolean) {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionEnvelope>;
    if (parsed.schema === 1 && parsed.kind === "biolang-studio-session" && typeof parsed.payload === "string" && /^[a-f0-9]{64}$/i.test(parsed.sha256 ?? "")) {
      return await sha256(parsed.payload) === parsed.sha256!.toLowerCase() ? parsed.payload : null;
    }
    return allowLegacy ? raw : null;
  } catch { return null; }
}

let sessionWriteQueue = Promise.resolve();

async function writeWorkspaceSession(payload: string) {
  const temporary = `${SESSION_FILE}.temporary`;
  const backup = `${SESSION_FILE}.backup`;
  const previous = await readWorkspaceFile(SESSION_FILE);
  if (previous) await saveWorkspace(backup, previous);
  const encoded = JSON.stringify(await encodeSession(payload));
  await saveWorkspace(temporary, encoded);
  await saveWorkspace(SESSION_FILE, encoded);
  await removeWorkspaceFile(temporary);
}

export function saveWorkspaceSession(payload: string) {
  const write = sessionWriteQueue.then(() => writeWorkspaceSession(payload));
  sessionWriteQueue = write.catch(() => undefined);
  return write;
}

export async function loadWorkspaceSession(validate: (payload: string) => boolean): Promise<{ payload: string; recoveredFrom: "primary" | "temporary" | "backup" | "legacy" } | null> {
  const candidates = [
    { name: SESSION_FILE, recoveredFrom: "primary" as const, legacy: true },
    { name: `${SESSION_FILE}.temporary`, recoveredFrom: "temporary" as const, legacy: false },
    { name: `${SESSION_FILE}.backup`, recoveredFrom: "backup" as const, legacy: true },
  ];
  for (const candidate of candidates) {
    const raw = await readWorkspaceFile(candidate.name);
    if (!raw) continue;
    const payload = await decodeSession(raw, candidate.legacy);
    if (!payload) continue;
    try {
      if (validate(payload)) return { payload, recoveredFrom: candidate.recoveredFrom === "primary" && raw === payload ? "legacy" : candidate.recoveredFrom };
    } catch { /* Try the recoverable copy. */ }
  }
  return null;
}
