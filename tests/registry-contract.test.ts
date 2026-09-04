import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { filterRegistry, registrySearchText, validateRegistry } from "../src/content/registry";

const registryRoot = resolve(process.cwd(), "../biolang-registry/registry/v1");
const indexPath = resolve(registryRoot, "index.json");
const searchPath = resolve(registryRoot, "search-index.json");
const siblingRegistryAvailable = existsSync(indexPath) && existsSync(searchPath);

describe.skipIf(!siblingRegistryAvailable)("public Registry and Studio discovery contract", () => {
  const rawIndex = JSON.parse(readFileSync(indexPath, "utf8"));
  const searchIndex = JSON.parse(readFileSync(searchPath, "utf8"));
  const index = validateRegistry(rawIndex);
  const activeEntries = index.entries.filter(entry => entry.status !== "withdrawn");

  it("uses the registry's exact search text and verification state", () => {
    const documents = new Map(searchIndex.documents.map((document: { id: string; version: string }) => [`${document.id}@${document.version}`, document]));
    for (const entry of activeEntries) {
      const document = documents.get(`${entry.id}@${entry.version}`) as { text: string } | undefined;
      expect(document?.text).toBe(registrySearchText(entry));
      expect(entry.verified).toBe(rawIndex.entries.find((candidate: { id: string; version: string }) => candidate.id === entry.id && candidate.version === entry.version)?.verified);
    }
    for (const entry of index.entries.filter(entry => entry.status === "withdrawn")) {
      expect(documents.has(`${entry.id}@${entry.version}`)).toBe(false);
    }
  });

  it("resolves every exact version and returns active entries through title search", () => {
    for (const entry of index.entries) {
      expect(index.entries.find(candidate => candidate.id === entry.id && candidate.version === entry.version)).toEqual(entry);
      if (entry.status === "withdrawn") continue;
      const distinctive = entry.title.toLowerCase().split(/\s+/).find(word => word.length >= 4);
      if (distinctive) expect(filterRegistry(index.entries, { query: distinctive })).toContainEqual(entry);
    }
  });

  it("finds lessons by problems, methods, plots, aliases, and BioLang functions", () => {
    const lessons = activeEntries.filter(entry => entry.kind === "lesson");
    for (const entry of lessons) {
      const discovery = entry.discoverability;
      expect(discovery).toBeDefined();
      for (const field of ["problems", "methods", "plots", "terms", "aliases", "functions"] as const) {
        const phrase = discovery![field][0];
        expect(filterRegistry(index.entries, { query: phrase, kind: "lesson" })).toContainEqual(entry);
      }
    }
  });
});
