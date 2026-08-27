import { describe, expect, it } from "vitest";
import { directives, executableSource, parseNotebook, serializeNotebook } from "../src/notebook/format";
import { validateManifest } from "../src/content/manifest";
import { validateRegistry } from "../src/content/registry";

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
});
