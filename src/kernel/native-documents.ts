import { desktopAvailable } from "./desktop-client";

export type NativeDocumentKind = "notebook" | "workspace";

export interface NativeDocumentBinding {
  path: string;
  filename: string;
  size: number;
  sha256: string;
  modifiedMs: number;
}

export interface NativeDocument extends NativeDocumentBinding {
  contents: string;
}

export interface NativeDocumentStatus {
  exists: boolean;
  changed: boolean;
  currentSha256?: string;
  modifiedMs?: number;
}

export interface NativeSaveResult {
  status: "saved" | "conflict";
  path: string;
  document?: NativeDocument;
  currentSha256?: string;
}

export interface RecentNativeDocument {
  kind: NativeDocumentKind;
  path: string;
  filename: string;
  openedAt: string;
}

const RECENT_KEY = "biolang-studio:recent-native-documents:v1";
const MAX_RECENT = 8;

function invoke<T>(command: string, payload?: unknown) {
  if (!window.__BIOLANG_DESKTOP__) throw new Error("BioLang Studio Desktop is not available.");
  return window.__BIOLANG_DESKTOP__.invoke<T>(command, payload);
}

export function nativeDocumentsAvailable() { return desktopAvailable(); }

export function openNativeDocument(kind: NativeDocumentKind, path?: string) {
  return invoke<NativeDocument | null>("studio_open_document", { kind, path });
}

export function saveNativeDocument(request: {
  kind: NativeDocumentKind;
  path?: string;
  suggestedName: string;
  contents: string;
  expectedSha256?: string;
  overwrite?: boolean;
}) {
  return invoke<NativeSaveResult | null>("studio_save_document", {
    request: { ...request, overwrite: request.overwrite ?? false },
  });
}

export function nativeDocumentStatus(binding: NativeDocumentBinding) {
  return invoke<NativeDocumentStatus>("studio_document_status", { path: binding.path, expectedSha256: binding.sha256 });
}

export function readRecentNativeDocuments(): RecentNativeDocument[] {
  if (!nativeDocumentsAvailable()) return [];
  try {
    const decoded = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(decoded)) return [];
    return decoded.filter((item): item is RecentNativeDocument =>
      item && (item.kind === "notebook" || item.kind === "workspace") &&
      typeof item.path === "string" && typeof item.filename === "string" && typeof item.openedAt === "string"
    ).slice(0, MAX_RECENT);
  } catch { return []; }
}

export function rememberNativeDocument(kind: NativeDocumentKind, document: NativeDocumentBinding) {
  const next: RecentNativeDocument[] = [
    { kind, path: document.path, filename: document.filename, openedAt: new Date().toISOString() },
    ...readRecentNativeDocuments().filter(item => item.path !== document.path),
  ].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function forgetRecentNativeDocument(path: string) {
  const next = readRecentNativeDocuments().filter(item => item.path !== path);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}
