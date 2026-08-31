import { describe, expect, it } from "vitest";
import { directives, executableSource, expandMixedMarkdown, parseNotebook, serializeNotebook, type NotebookCell } from "../src/notebook/format";
import { compileNotebookCode, readNotebookCodeLanguage, saveNotebookCodeLanguage } from "../src/notebook/language";
import { lessonEntryForDocument, manifestLessonEntries, validateManifest } from "../src/content/manifest";
import { lessonUpdateAvailable } from "../src/content/installed";
import { manifestLessonShareUrl, parseLessonLaunchUrl, registryLessonShareUrl, removeLessonLaunchParams } from "../src/content/lesson-links";
import { filterRegistry, latestRegistryEntry, publicRegistryUrl, searchRegistry, validateRegisteredDatasetManifest, validateRegistry, type RegistryEntry } from "../src/content/registry";
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

describe("paired JavaScript lesson view", () => {
  it("keeps structural JavaScript separate from the canonical kernel source", () => {
    const source = "let measurements = [12, 14, 15]\nsummary(measurements)";
    const generated = "let measurements = [12, 14, 15];\nlet result = await bl.summary(measurements);\nresult;";
    const compiled = compileNotebookCode(source, "javascript", generated);
    expect(compiled.frontendSource).toContain("bl.summary(measurements)");
    expect(compiled.frontendSource).not.toContain("bl.define");
    expect(compiled.frontendSource).not.toContain("`let measurements");
    expect(compiled.biolangSource).toBe(source);
  });
  it("uses URL language overrides and otherwise remembers the reader preference", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveNotebookCodeLanguage("javascript", storage);
    expect(readNotebookCodeLanguage("https://studio.lang.bio/", storage)).toBe("javascript");
    expect(readNotebookCodeLanguage("https://studio.lang.bio/?lang=bl", storage)).toBe("biolang");
    expect(readNotebookCodeLanguage("https://studio.lang.bio/?lang=js", null)).toBe("javascript");
  });
  it("compiles both frontends to the same canonical kernel source", () => {
    const source = "let values = [1, 2, 3]\nmean(values)";
    const biolang = compileNotebookCode(source, "biolang");
    const javascript = compileNotebookCode(source, "javascript", "await bl.mean(values)");
    expect(biolang.frontendSource).toBe(source);
    expect(javascript.frontendSource).toContain("bl.mean");
    expect(javascript.biolangSource).toBe(biolang.biolangSource);
  });
});

describe("content manifests", () => {
  it("parses exact registry and checksum-pinned direct lesson links without autorun state", () => {
    expect(parseLessonLaunchUrl("https://studio.lang.bio/?lesson=oriclabs%2Fbdsr-survival-analysis%400.1.0&run=all")).toEqual({
      kind: "registry", id: "oriclabs/bdsr-survival-analysis", version: "0.1.0"
    });
    expect(parseLessonLaunchUrl(`https://studio.lang.bio/?manifest=${encodeURIComponent("https://example.test/lesson.json")}&sha256=${"A".repeat(64)}`)).toEqual({
      kind: "manifest", manifest: "https://example.test/lesson.json", sha256: "a".repeat(64)
    });
    expect(() => parseLessonLaunchUrl("https://studio.lang.bio/?lesson=test/demo@1.0.0&manifest=https://example.test/lesson.json")).toThrow();
  });
  it("builds share links without carrying unrelated workspace or run parameters", () => {
    const registry = registryLessonShareUrl("https://studio.lang.bio/?view=registry&q=old#cell", "oriclabs/demo", "1.2.3");
    expect(registry).toBe("https://studio.lang.bio/?lesson=oriclabs%2Fdemo%401.2.3");
    const direct = manifestLessonShareUrl("https://studio.lang.bio/?view=registry", "https://example.test/lesson.json", "b".repeat(64));
    expect(parseLessonLaunchUrl(direct)).toEqual({ kind: "manifest", manifest: "https://example.test/lesson.json", sha256: "b".repeat(64) });
    const cleaned = removeLessonLaunchParams(`${direct}&q=keep&run=all`);
    expect(cleaned).toContain("q=keep");
    expect(cleaned).not.toContain("manifest=");
    expect(cleaned).not.toContain("run=");
  });
  it("builds a canonical public catalogue handoff with supported filters", () => {
    expect(publicRegistryUrl({ query: "survival analysis", kind: "lesson", runtime: "browser" }, "oriclabs/demo@1.2.3"))
      .toBe("https://registry.lang.bio/?q=survival+analysis&kind=lesson&entry=oriclabs%2Fdemo%401.2.3");
  });
  it("selects semantic registry versions rather than lexicographic versions", () => {
    const base = {
      schema: 1, kind: "lesson", id: "test/demo", name: "demo", title: "Demo", summary: "", publisher: "test", version: "1.0.0",
      status: "stable", verified: true, manifest: "https://example.test/lesson.json", manifestSha256: "a".repeat(64),
      publishedAt: "2026-08-30", compatibility: { runtimes: ["browser"] }, categories: ["teaching"], tags: [],
      sourceRepository: "https://example.test/source", licence: "MIT", validation: "fixture"
    } as RegistryEntry;
    expect(latestRegistryEntry([{ ...base, version: "1.9.0" }, { ...base, version: "1.10.0" }], base.id)?.version).toBe("1.10.0");
    expect(latestRegistryEntry([{ ...base, version: "2.0.0-beta.1" }, { ...base, version: "2.0.0" }], base.id)?.version).toBe("2.0.0");
  });
  it("accepts an ordered schema-2 lesson collection", () => {
    const manifest = validateManifest({
      schema: 2, id: "biomedical-series", title: "Biomedical series", summary: "A sequence of lessons.",
      runtime: "browser", estimatedMemoryMb: 2,
      source: { title: "Open source", url: "https://example.test/source", note: "Adapted" },
      datasets: [], tags: ["statistics"],
      lessons: [
        { id: "risk", title: "Risk", summary: "Compare risks.", entry: "01-risk.bln" },
        { id: "trials", title: "Trials", summary: "Plan trials.", entry: "02-trials.bln" },
      ],
    });
    expect(manifestLessonEntries(manifest).map(lesson => lesson.id)).toEqual(["risk", "trials"]);
    expect(lessonEntryForDocument(manifest, "trials.bln", 0).id).toBe("trials");
    expect(lessonEntryForDocument(manifest, "renamed-by-learner.bln", 1).id).toBe("trials");
  });
  it("keeps independently installable lessons related through validated series metadata", () => {
    const manifest = validateManifest({
      schema: 1, id: "chapter-eight", title: "Statistics", summary: "A chapter companion", entry: "lesson.bln",
      runtime: "browser", estimatedMemoryMb: 2,
      source: { title: "Book chapter", url: "https://example.test/chapter", note: "Independent companion" },
      series: { id: "example-book", title: "Example book", url: "https://example.test/", order: 8, chapter: "Chapter 8 · Statistics" },
      datasets: [], tags: ["statistics"]
    });
    expect(manifest.series?.order).toBe(8);
    expect(() => validateManifest({ ...manifest, series: { ...manifest.series!, url: "javascript:alert(1)" } })).toThrow();
  });
  it("rejects duplicate or escaping collection entries", () => {
    expect(() => validateManifest({
      schema: 2, id: "bad", title: "Bad", summary: "Bad collection", runtime: "browser", estimatedMemoryMb: 1,
      source: { title: "Source", url: "https://example.test", note: "Test" }, datasets: [], tags: [],
      lessons: [
        { id: "same", title: "One", summary: "", entry: "../one.bln" },
        { id: "same", title: "Two", summary: "", entry: "../one.bln" },
      ],
    })).toThrow();
  });
  it("rejects unverified or insecure datasets", () => {
    expect(() => validateManifest({ schema: 1, id: "x", title: "x", entry: "x.bln", tags: [], datasets: [{ id: "d", path: "d", url: "http://example.test/d", sha256: "bad", bytes: 1 }] })).toThrow();
  });
  it("allows loopback lesson sources only when local development is explicit", () => {
    const local = {
      schema: 1, id: "local", title: "Local", summary: "Local lesson", entry: "lesson.bln",
      runtime: "browser", estimatedMemoryMb: 1,
      source: { title: "Local source", url: "http://127.0.0.1:4310/source", note: "Development" },
      datasets: [{ id: "tiny", title: "Tiny", path: "tiny.csv", url: "http://localhost:4310/tiny.csv",
        bytes: 1, sha256: "a".repeat(64), mediaType: "text/csv", source: "Local", citation: "Local", rights: "Local" }],
      tags: ["local"]
    };
    expect(() => validateManifest(local)).toThrow();
    expect(validateManifest(local, { allowLoopback: true }).id).toBe("local");
    expect(() => validateManifest({ ...local, source: { ...local.source, url: "http://example.test/source" } }, { allowLoopback: true })).toThrow();
  });
  it("rejects registry entries without a pinned manifest checksum", () => {
    expect(() => validateRegistry({ schema: 1, entries: [{ schema: 1, kind: "lesson", id: "test/demo", publisher: "test", name: "demo", manifest: "https://example.test/lesson.json", manifestSha256: "bad" }] })).toThrow();
  });
  it("detects an installed lesson whose registry checksum or source changed", () => {
    const registered = {
      kind: "lesson", name: "demo", manifest: "/lesson.json", manifestSha256: "b".repeat(64)
    } as RegistryEntry;
    const installed = {
      id: "demo", title: "Demo", summary: "", manifest: "http://127.0.0.1:4173/lesson.json",
      runtime: "browser" as const, tags: [] as string[], manifestSha256: "a".repeat(64)
    };
    expect(lessonUpdateAvailable(installed, registered, "http://127.0.0.1:4173/")).toBe(true);
    expect(lessonUpdateAvailable({ ...installed, manifestSha256: "b".repeat(64) }, registered, "http://127.0.0.1:4173/")).toBe(false);
    expect(lessonUpdateAvailable({ ...installed, manifest: "/old.json", manifestSha256: "b".repeat(64) }, registered, "http://127.0.0.1:4173/")).toBe(true);
  });
  it("allows loopback manifests only in an explicitly local registry", () => {
    const entry = {
      schema: 1, kind: "lesson", id: "test/local", publisher: "test", name: "local", title: "Local lesson",
      summary: "Development lesson", version: "0.1.0", status: "preview", verified: false,
      manifest: "http://127.0.0.1:4310/lesson.json", manifestSha256: "a".repeat(64), publishedAt: "2026-08-29",
      compatibility: { runtimes: ["browser"] }, categories: ["teaching"], tags: ["local"],
      sourceRepository: "https://github.com/example/local", licence: "MIT", validation: "local"
    };
    expect(() => validateRegistry({ schema: 1, entries: [entry] })).toThrow();
    expect(validateRegistry({ schema: 1, entries: [entry] }, { allowLoopback: true }).entries[0].manifest).toBe(entry.manifest);
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
    expect(searchRegistry([entry], "test/direct", "dataset")).toEqual([entry]);
    expect(searchRegistry([entry], "mouse", "dataset")).toEqual([]);
    expect(filterRegistry([entry], { runtime: "browser", access: "public", verification: "verified" })).toEqual([entry]);
    expect(filterRegistry([entry], { runtime: "desktop", access: "controlled" })).toEqual([]);
  });
  it("searches provider authentication and ranks direct title matches above summary-only matches", () => {
    const base = {
      schema: 1, kind: "provider", publisher: "test", version: "1.0.0", status: "stable", verified: true,
      manifest: "https://example.test/provider.json", manifestSha256: "a".repeat(64), publishedAt: "2026-08-28",
      compatibility: { runtimes: ["cli"] }, categories: ["data"], tags: [], sourceRepository: "https://example.test/source",
      licence: "MIT", validation: "registry-verified",
      provider: { adapter: "http", authentication: "oauth", capabilities: ["download"], apiDocumentation: "https://example.test/api" }
    } as const;
    const summaryMatch = { ...base, id: "test/archive", name: "archive", title: "Archive", summary: "A genomic atlas provider" } as unknown as RegistryEntry;
    const titleMatch = { ...base, id: "test/atlas", name: "atlas", title: "Genomic atlas", summary: "Downloads data" } as unknown as RegistryEntry;
    expect(searchRegistry([summaryMatch], "oauth http", "provider")).toEqual([summaryMatch]);
    expect(filterRegistry([summaryMatch, titleMatch], { query: "atlas", sort: "relevance" }).map(entry => entry.id)).toEqual(["test/atlas", "test/archive"]);
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
      notebooks: [{ id: "one", filename: "one.bln", source: "1 + 1\n", lessonManifestSha256: digest, attachmentIds: [attachmentId("table.csv", digest)] }],
      attachments: [{ id: attachmentId("table.csv", digest), path: "table.csv", size: 12, sha256: digest, mediaType: "text/csv", scope: { kind: "workspace" }, source: { kind: "local" } }]
    });
    expect(workspace.notebooks[0].source).toBe("1 + 1\n");
    expect(workspace.notebooks[0].lessonManifestSha256).toBe(digest);
    expect(JSON.stringify(workspace)).not.toContain("contents");
    expect(() => validatePortableWorkspace({ ...workspace, notebooks: [{ ...workspace.notebooks[0], lessonManifestSha256: "not-a-digest" }] })).toThrow(/notebook record/);
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
