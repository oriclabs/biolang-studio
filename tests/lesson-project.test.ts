import { describe, expect, it } from "vitest";
import { buildLessonProject, generatedBioLangScript, lessonDataLock } from "../src/export/lesson-project";
import type { LessonManifest } from "../src/content/manifest";

const cells = [
  { id: "m", type: "markdown" as const, source: "# Explain" },
  { id: "a", type: "code" as const, source: "let value = 42" },
  { id: "s", type: "code" as const, source: "# @skip\nremove_everything()" },
  { id: "b", type: "code" as const, source: "# @hide-output\nvalue + 1" },
];

const lesson: LessonManifest = {
  schema: 1,
  id: "example",
  title: "Example lesson",
  summary: "A fixture",
  entry: "example.bln",
  runtime: "browser",
  estimatedMemoryMb: 10,
  source: { title: "Original source", url: "https://example.test/source", note: "Independently explained." },
  datasets: [{
    id: "table", title: "Example table", path: "data/example.csv", url: "https://example.test/example.csv",
    bytes: 12, sha256: "a".repeat(64), mediaType: "text/csv", source: "Example archive",
    citation: "Example citation", rights: "CC0",
  }],
  tags: ["fixture"],
};

describe("CLI lesson project export", () => {
  it("generates code in notebook order while omitting skipped cells and directives", () => {
    const script = generatedBioLangScript(cells, "analysis.bln");
    expect(script).toContain("let value = 42");
    expect(script).toContain("value + 1");
    expect(script).not.toContain("remove_everything");
    expect(script).not.toContain("@hide-output");
    expect(script.indexOf("let value")).toBeLessThan(script.indexOf("value + 1"));
  });

  it("pins every declared input without embedding its bytes", () => {
    const lock = lessonDataLock({ filename: "analysis.bln", workspaceName: "Analysis", cells, lesson, generatedAt: "2026-08-30T00:00:00.000Z" });
    expect(lock.project).toEqual({ notebook: "analysis.bln", script: "analysis.bl" });
    expect(lock.files[0]).toMatchObject({ path: "data/example.csv", bytes: 12, sha256: "a".repeat(64), rights: "CC0", role: "input" });
    expect(JSON.stringify(lock)).not.toContain("fixture-bytes");
  });

  it("creates a ZIP containing notebook, script, lock, readme, and provenance", () => {
    const project = buildLessonProject({ filename: "analysis.bln", workspaceName: "Analysis", cells, lesson, generatedAt: "2026-08-30T00:00:00.000Z" });
    const archiveText = new TextDecoder().decode(project.bytes);
    expect(project.filename).toBe("analysis-cli.zip");
    for (const name of ["analysis.bln", "analysis.bl", "lesson-data.json", "README.md", "PROVENANCE.md"]) expect(archiveText).toContain(name);
    expect(project.script).not.toContain("remove_everything");
    expect(project.notebook).toContain("remove_everything");
  });
});
