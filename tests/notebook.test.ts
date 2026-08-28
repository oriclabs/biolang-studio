import { describe, expect, it } from "vitest";
import { directives, executableSource, parseNotebook, serializeNotebook } from "../src/notebook/format";
import { validateManifest } from "../src/content/manifest";
import { filterRegistry, searchRegistry, validateRegisteredDatasetManifest, validateRegistry, type RegistryEntry } from "../src/content/registry";

describe("BioLang notebook format", () => {
  it("round trips prose and executable fences", () => {
    const source = "# Why\n\n```biolang\nlet x = 4\nx * 2\n```\n\nDone.\n";
    const cells = parseNotebook(source);
    expect(cells.map(cell => cell.type)).toEqual(["markdown", "code", "markdown"]);
    expect(parseNotebook(serializeNotebook(cells)).map(cell => [cell.type, cell.source])).toEqual(cells.map(cell => [cell.type, cell.source]));
  });
  it("keeps directives out of executable source", () => {
    expect(directives("# @skip\n1 + 1").skip).toBe(true);
    expect(executableSource("# @hide-output\n1 + 1")).toBe("1 + 1");
  });
});

describe("content manifests", () => {
  it("rejects unverified or insecure datasets", () => {
    expect(() => validateManifest({ schema: 1, id: "x", title: "x", entry: "x.bln", tags: [], datasets: [{ id: "d", path: "d", url: "http://example.test/d", sha256: "bad", bytes: 1 }] })).toThrow();
  });
  it("rejects registry entries without a pinned manifest checksum", () => {
    expect(() => validateRegistry({ schema: 1, entries: [{ schema: 1, kind: "lesson", id: "test/demo", publisher: "test", name: "demo", manifest: "https://example.test/lesson.json", manifestSha256: "bad" }] })).toThrow();
  });
  it("searches dataset discovery metadata and categories", () => {
    const entry = {
      schema: 1, kind: "dataset", id: "test/cells", publisher: "test", name: "cells", title: "PBMC cells",
      summary: "A single-cell teaching matrix", version: "1.0.0", status: "stable", verified: true,
      manifest: "https://example.test/dataset.json", manifestSha256: "a".repeat(64), publishedAt: "2026-08-28",
      compatibility: { runtimes: ["browser", "cli"] }, categories: ["single-cell"], tags: ["PBMC"],
      sourceRepository: "https://example.test/source", licence: "CC0", validation: "registry-verified",
      dataset: { provider: "test/direct", access: "public", formats: ["mtx"], modalities: ["RNA"], organisms: ["Homo sapiens"], fileCount: 1, totalBytes: 10 }
    } as RegistryEntry;
    expect(searchRegistry([entry], "sapiens mtx", "dataset", "single-cell")).toEqual([entry]);
    expect(searchRegistry([entry], "mouse", "dataset")).toEqual([]);
    expect(filterRegistry([entry], { runtime: "browser", access: "public", verification: "verified" })).toEqual([entry]);
    expect(filterRegistry([entry], { runtime: "desktop", access: "controlled" })).toEqual([]);
  });
  it("rejects traversal in registered dataset files", () => {
    expect(() => validateRegisteredDatasetManifest({
      schema: 1, kind: "dataset", id: "test/cells", version: "1.0.0", title: "Cells", summary: "", description: "Test",
      categories: ["single-cell"], tags: [], modalities: ["RNA"], organisms: ["Homo sapiens"], provider: "test/direct",
      access: { kind: "public", requiresAcceptance: false },
      source: { landingPage: "https://example.test", citation: "Test", licence: "CC0", rights: "Open" },
      files: [{ id: "matrix", title: "Matrix", path: "../matrix.csv", url: "https://example.test/matrix.csv", bytes: 1, sha256: "a".repeat(64), mediaType: "text/csv", format: "csv", role: "primary", reader: "read_csv" }]
    })).toThrow();
  });
});
