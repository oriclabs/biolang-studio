import type { AttachedFile } from "../kernel/protocol";
import type { DatasetManifest } from "../content/manifest";

const CACHE_NAME = "biolang-studio-content-v1";

export async function sha256(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function cache(): Promise<Cache | null> {
  return "caches" in globalThis ? caches.open(CACHE_NAME) : null;
}

function cacheKey(dataset: DatasetManifest) {
  return new URL(`./__content/${dataset.sha256}/${encodeURIComponent(dataset.path)}`, location.href).href;
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
  const contents = await response.text();
  return { path: dataset.path, contents, size: new TextEncoder().encode(contents).byteLength, sha256: dataset.sha256 };
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
