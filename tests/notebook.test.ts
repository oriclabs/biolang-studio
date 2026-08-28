import { describe, expect, it } from "vitest";
import { directives, executableSource, expandMixedMarkdown, parseNotebook, serializeNotebook, type NotebookCell } from "../src/notebook/format";
import { validateManifest } from "../src/content/manifest";
import { filterRegistry, searchRegistry, validateRegisteredDatasetManifest, validateRegistry, type RegistryEntry } from "../src/content/registry";
import { assertUnambiguousMountPaths, attachmentId, migratePortableWorkspace, validatePortableWorkspace, WORKSPACE_SCHEMA_URL, type WorkspaceAttachment } from "../src/workspace/format";

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
  it("groups optional lesson steps and preserves them through markdown", () => {
    const source = '<!-- bl:step title="Choosing the centre" -->\n\nWhy does the centre move?\n\n```biolang\nmean(values)\n```\n\nCompare the median.\n\n<!-- /bl:step -->\n';
    const cells = parseNotebook(source);
    expect(cells.map(cell => cell.type)).toEqual(["markdown", "code", "markdown"]);
    expect(new Set(cells.map(cell => cell.step?.id)).size).toBe(1);
    expect(cells.every(cell => cell.step?.title === "Choosing the centre")).toBe(true);
    expect(serializeNotebook(cells)).toBe(source);
  });
  it("expands explicitly fenced BioLang inside an explanation but leaves inline code alone", () => {
    const mixed = { id: "mixed", type: "markdown", source: "Explain `mean(x)`.\n\n```biolang\nmean(x)\n```\n\nInterpret it.", status: "" } as NotebookCell;
    expect(expandMixedMarkdown(mixed).map(cell => cell.type)).toEqual(["markdown", "code", "markdown"]);
    const inline = { ...mixed, source: "Explain `mean(x)` without running it." };
    expect(expandMixedMarkdown(inline)).toEqual([inline]);
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

describe("portable workspaces", () => {
  it("keeps notebook source and explicit data references without raw bytes", () => {
    const digest = "a".repeat(64);
    const workspace = validatePortableWorkspace({
      schema: 3, kind: "biolang-workspace", name: "Teaching", activeNotebookId: "one",
      notebooks: [{ id: "one", filename: "one.bln", source: "1 + 1\n", attachmentIds: [attachmentId("table.csv", digest)] }],
      attachments: [{ id: attachmentId("table.csv", digest), path: "table.csv", size: 12, sha256: digest, mediaType: "text/csv", scope: { kind: "workspace" }, source: { kind: "local" } }]
    });
    expect(workspace.notebooks[0].source).toBe("1 + 1\n");
    expect(JSON.stringify(workspace)).not.toContain("contents");
  });

  it("rejects escaping paths and incorrectly scoped data", () => {
    const digest = "b".repeat(64);
    expect(() => validatePortableWorkspace({
      schema: 3, kind: "biolang-workspace", name: "Bad", activeNotebookId: "one",
      notebooks: [{ id: "one", filename: "one.bln", source: "", attachmentIds: [attachmentId("x.csv", digest)] }],
      attachments: [{ id: attachmentId("x.csv", digest), path: "x.csv", size: 1, sha256: digest, mediaType: "text/csv", scope: { kind: "notebook", notebookId: "two" }, source: { kind: "local" } }]
    })).toThrow();
  });

  it("rejects two different files mounted at the same path", () => {
    const make = (digest: string, scope: WorkspaceAttachment["scope"]): WorkspaceAttachment => ({
      id: attachmentId("data.csv", digest), path: "data.csv", size: 1, sha256: digest,
      mediaType: "text/csv", scope, source: { kind: "local" }
    });
    expect(() => assertUnambiguousMountPaths([
      make("a".repeat(64), { kind: "workspace" }),
      make("b".repeat(64), { kind: "notebook", notebookId: "one" })
    ], ["one", "two"])).toThrow(/data\.csv/);
    expect(() => assertUnambiguousMountPaths([
      make("a".repeat(64), { kind: "notebook", notebookId: "one" }),
      make("b".repeat(64), { kind: "notebook", notebookId: "two" })
    ], ["one", "two"])).not.toThrow();
  });

  it("identifies the published schema and rejects unsupported versions clearly", () => {
    expect(WORKSPACE_SCHEMA_URL).toMatch(/biolang-workspace-v3\.schema\.json$/);
    const migrated = migratePortableWorkspace({
      schema: 1, kind: "biolang-workspace", name: "Old", activeNotebookId: "one",
      notebooks: [{ id: "one", filename: "old.bln", source: "", attachmentIds: [] }], attachments: []
    });
    expect(migrated.schema).toBe(3);
    expect(migrated.$schema).toBe(WORKSPACE_SCHEMA_URL);
    expect(() => migratePortableWorkspace({ schema: 4 })).toThrow(/newer than this Studio/);
    expect(() => migratePortableWorkspace({ schema: 0 })).toThrow(/no safe migration/);
  });

  it("preserves verified HTTPS provenance without embedding downloaded bytes", () => {
    const mountedDigest = "c".repeat(64);
    const sourceDigest = "d".repeat(64);
    const workspace = validatePortableWorkspace({
      schema: 3, kind: "biolang-workspace", name: "Remote", activeNotebookId: "one",
      notebooks: [{ id: "one", filename: "remote.bln", source: "", attachmentIds: [attachmentId("cells.csv", mountedDigest)] }],
      attachments: [{
        id: attachmentId("cells.csv", mountedDigest), path: "cells.csv", size: 12, sha256: mountedDigest,
        mediaType: "text/csv", scope: { kind: "notebook", notebookId: "one" },
        source: { kind: "url", url: "https://data.example.test/cells.csv", sourceBytes: 12, sourceSha256: sourceDigest, retrievedAt: "2026-08-28T00:00:00.000Z" }
      }]
    });
    expect(workspace.attachments[0].source.kind).toBe("url");
    expect(JSON.stringify(workspace)).not.toContain("contents");
    expect(() => validatePortableWorkspace({ ...workspace, attachments: [{ ...workspace.attachments[0], source: { ...(workspace.attachments[0].source as object), kind: "url", url: "http://data.example.test/cells.csv" } }] })).toThrow(/provenance/);
  });

  it("preserves checksum-pinned output provenance for later notebooks", () => {
    const digest = "e".repeat(64);
    const sourceDigest = "f".repeat(64);
    const workspace = validatePortableWorkspace({
      schema: 3, kind: "biolang-workspace", name: "Outputs", activeNotebookId: "two",
      notebooks: [
        { id: "one", filename: "prepare.bln", source: "", attachmentIds: [attachmentId("outputs/qc.csv", digest)] },
        { id: "two", filename: "analyse.bln", source: "", attachmentIds: [attachmentId("outputs/qc.csv", digest)] },
      ],
      attachments: [{
        id: attachmentId("outputs/qc.csv", digest), path: "outputs/qc.csv", size: 42, sha256: digest,
        mediaType: "text/csv", scope: { kind: "workspace" },
        source: { kind: "output", producerNotebookId: "one", producerNotebookFilename: "prepare.bln", variable: "qc", format: "csv", createdAt: "2026-08-28T00:00:00.000Z", executedSourceSha256: sourceDigest },
      }],
    });
    expect(workspace.attachments[0].source).toMatchObject({ kind: "output", variable: "qc", producerNotebookId: "one" });
    expect(JSON.stringify(workspace)).not.toContain("contents");
    expect(() => validatePortableWorkspace({ ...workspace, attachments: [{ ...workspace.attachments[0], source: { ...(workspace.attachments[0].source as object), createdAt: "not-a-date" } }] })).toThrow(/output provenance/);
  });
});
