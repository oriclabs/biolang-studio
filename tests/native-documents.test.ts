// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { openNativeDocument, readRecentNativeDocuments, rememberNativeDocument, saveNativeDocument } from "../src/kernel/native-documents";

describe("native document bridge", () => {
  afterEach(() => {
    delete window.__BIOLANG_DESKTOP__;
    localStorage.clear();
  });

  it("opens a recent absolute path and sends conflict metadata on save", async () => {
    const invoke = vi.fn(async (command: string, payload?: unknown) => {
      if (command === "studio_open_document") return { path: "C:\\work\\analysis.bln", filename: "analysis.bln", contents: "1 + 1", size: 5, sha256: "a".repeat(64), modifiedMs: 10 };
      if (command === "studio_save_document") return { status: "conflict", path: "C:\\work\\analysis.bln", currentSha256: "b".repeat(64) };
      throw new Error(`unexpected ${command} ${JSON.stringify(payload)}`);
    });
    window.__BIOLANG_DESKTOP__ = { invoke: invoke as <T>(command: string, payload?: unknown) => Promise<T> };

    await expect(openNativeDocument("notebook", "C:\\work\\analysis.bln")).resolves.toMatchObject({ filename: "analysis.bln" });
    await expect(saveNativeDocument({ kind: "notebook", path: "C:\\work\\analysis.bln", suggestedName: "analysis.bln", contents: "2 + 2", expectedSha256: "a".repeat(64) })).resolves.toMatchObject({ status: "conflict" });
    expect(invoke).toHaveBeenNthCalledWith(1, "studio_open_document", { kind: "notebook", path: "C:\\work\\analysis.bln" });
    expect(invoke).toHaveBeenNthCalledWith(2, "studio_save_document", { request: expect.objectContaining({ overwrite: false, expectedSha256: "a".repeat(64) }) });
  });

  it("keeps a bounded, most-recent-first device-local list", () => {
    window.__BIOLANG_DESKTOP__ = { invoke: vi.fn() as unknown as <T>(command: string, payload?: unknown) => Promise<T> };
    for (let index = 0; index < 10; index++) {
      rememberNativeDocument("notebook", { path: `C:\\work\\${index}.bln`, filename: `${index}.bln`, size: 1, sha256: `${index}`.repeat(64).slice(0, 64), modifiedMs: index });
    }
    const recent = readRecentNativeDocuments();
    expect(recent).toHaveLength(8);
    expect(recent[0].filename).toBe("9.bln");
    rememberNativeDocument("notebook", { path: "C:\\work\\5.bln", filename: "5.bln", size: 1, sha256: "5".repeat(64), modifiedMs: 5 });
    expect(readRecentNativeDocuments().map(item => item.filename)).toEqual(["5.bln", "9.bln", "8.bln", "7.bln", "6.bln", "4.bln", "3.bln", "2.bln"]);
  });
});
