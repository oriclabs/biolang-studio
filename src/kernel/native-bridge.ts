import { invoke, isTauri } from "@tauri-apps/api/core";

/** Expose the same narrow command bridge used by the browser-facing kernel client. */
export function installNativeBridge() {
  if (!isTauri() || window.__BIOLANG_DESKTOP__) return;
  window.__BIOLANG_DESKTOP__ = { invoke };
}
