// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopKernel, desktopAvailable } from "../src/kernel/desktop-client";

describe("DesktopKernel", () => {
  afterEach(() => { delete window.__BIOLANG_DESKTOP__; });

  it("keeps the native bridge explicit and passes the notebook namespace", async () => {
    const invoke = vi.fn(async (command: string, payload?: unknown) => {
      if (command === "kernel_initialize") return { ok: true };
      if (command === "kernel_execute") return {
        status: "ok", output: "", durationMs: 7,
        value: { kind: "scalar", typeName: "Int", text: "42", columns: [], rows: [], truncated: false },
        environment: { variables: [], totalBytes: 0 },
      };
      if (command === "kernel_cancel" || command === "kernel_dispose") return undefined;
      throw new Error(`unexpected ${command} ${JSON.stringify(payload)}`);
    });
    window.__BIOLANG_DESKTOP__ = { invoke: invoke as <T>(command: string, payload?: unknown) => Promise<T> };

    expect(desktopAvailable()).toBe(true);
    const kernel = new DesktopKernel("notebook-123");
    await kernel.initialize();
    expect(invoke).toHaveBeenNthCalledWith(1, "kernel_initialize", { namespace: "notebook-123" });
    await expect(kernel.execute("6 * 7")).resolves.toMatchObject({ ok: true, value: "42", backend: "desktop", elapsedMs: 7 });
    expect(invoke).toHaveBeenNthCalledWith(2, "kernel_execute", { namespace: "notebook-123", source: "6 * 7" });
    await kernel.cancel();
    expect(invoke).toHaveBeenNthCalledWith(3, "kernel_cancel", { namespace: "notebook-123" });
    kernel.dispose();
    expect(invoke).toHaveBeenNthCalledWith(4, "kernel_dispose", { namespace: "notebook-123" });
  });

  it("streams remote data and exact exports through native commands", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "kernel_fetch_url") return { path: "data/x.bam", size: 12, sha256: "a".repeat(64), mediaType: "application/octet-stream", sourceBytes: 12, sourceSha256: "a".repeat(64) };
      if (command === "kernel_export_variable") return { path: "C:\\results\\matrix.csv", bytes: 4096 };
      if (command === "kernel_publish_variable") return { path: "outputs/matrix.csv", size: 4096, sha256: "b".repeat(64), mediaType: "text/csv" };
      throw new Error(`unexpected ${command}`);
    });
    window.__BIOLANG_DESKTOP__ = { invoke: invoke as <T>(command: string, payload?: unknown) => Promise<T> };
    const kernel = new DesktopKernel("notebook-123");

    await expect(kernel.fetchRemote({ url: "https://example.org/x.bam", path: "data/x.bam", mediaType: "application/octet-stream" })).resolves.toMatchObject({ size: 12 });
    await expect(kernel.exportVariable("matrix", "csv", 1)).resolves.toMatchObject({ filename: "matrix.csv", savedPath: "C:\\results\\matrix.csv", byteLength: 4096 });
    await expect(kernel.publishVariable("matrix", "csv", "outputs/matrix.csv", 1)).resolves.toMatchObject({ path: "outputs/matrix.csv", sha256: "b".repeat(64) });
    expect(invoke).toHaveBeenLastCalledWith("kernel_publish_variable", { namespace: "notebook-123", name: "matrix", format: "csv", path: "outputs/matrix.csv" });
  });
});
