import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

const REGISTRY = "https://registry.lang.bio/v1/index.json";
const REGISTRY_FALLBACK = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";

test.beforeEach(async ({ page }) => {
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [] } }));
  await page.route(REGISTRY_FALLBACK, route => route.fulfill({ json: { schema: 1, entries: [] } }));
});

test("runs prerequisite cells in the isolated WASM kernel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("BioLang Studio")).toBeVisible();
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").nth(1).getByTitle("Run this cell and any prerequisites").click();
  await expect(page.locator("article.cell-code").nth(1).locator(".result")).toContainText("15", { timeout: 30_000 });
  await expect(page.getByText(/Earlier code cells were run when needed/)).toBeVisible();
});

test("adds and removes an external lesson package on demand", async ({ page }) => {
  await page.route("https://lessons.example.test/demo/lesson.json", route => route.fulfill({
    json: {
      schema: 1, id: "external-demo", title: "External demo", summary: "Installed only when requested.",
      entry: "lesson.bln", runtime: "browser", estimatedMemoryMb: 1,
      source: { title: "Test fixture", url: "https://lessons.example.test", note: "Synthetic" },
      datasets: [{
        id: "tiny", title: "Tiny CSV", path: "tiny.csv", url: "https://lessons.example.test/demo/tiny.csv",
        bytes: 12, sha256: "2a2b86e74ffd5e6a9b75e52a105cf9d02920837179f8e8961aa15411d380f7a3",
        mediaType: "text/csv", source: "Synthetic test fixture", citation: "None", rights: "Test data"
      }], tags: ["test"]
    }
  }));
  await page.route("https://lessons.example.test/demo/lesson.bln", route => route.fulfill({ contentType: "text/plain", body: "# External lesson\n\n```biolang\nlet tiny = read_csv(\"tiny.csv\")\nnrow(tiny)\n```\n" }));
  await page.route("https://lessons.example.test/demo/tiny.csv", route => route.fulfill({ contentType: "text/csv", body: "x,y\n1,2\n3,4\n" }));
  await page.goto("/");
  await expect(page.getByText("No lesson packages installed.")).toBeVisible();
  await page.getByRole("button", { name: "Add from manifest URL" }).click();
  await page.getByLabel("Manifest URL").fill("https://lessons.example.test/demo/lesson.json");
  await page.getByRole("button", { name: "Add lesson", exact: true }).click();
  await expect(page.getByRole("button", { name: /External demo/ })).toBeVisible();
  await expect(page.locator('input[aria-label="Notebook name"]')).toHaveValue("external-demo.bln");
  await page.getByRole("button", { name: "Prepare" }).click();
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible();
  await page.locator("article.cell-code").getByTitle("Run this cell and any prerequisites").click();
  await expect(page.locator("article.cell-code .result")).toContainText("2");
  await page.getByTitle("Remove External demo").click();
  await expect(page.getByText("No lesson packages installed.")).toBeVisible();
});

test("discovers, verifies, runs, and removes a registry lesson", async ({ page }) => {
  const manifest = {
    schema: 1, id: "registry-demo", title: "Registry demo", summary: "Discovered without being bundled into Studio.",
    entry: "lesson.bln", runtime: "browser", estimatedMemoryMb: 1,
    source: { title: "Test fixture", url: "https://registry-lesson.example.test", note: "Synthetic" },
    datasets: [{
      id: "tiny", title: "Tiny CSV", path: "tiny.csv", url: "https://registry-lesson.example.test/tiny.csv",
      bytes: 12, sha256: "2a2b86e74ffd5e6a9b75e52a105cf9d02920837179f8e8961aa15411d380f7a3",
      mediaType: "text/csv", source: "Synthetic test fixture", citation: "None", rights: "Test data"
    }], tags: ["test"]
  };
  const manifestText = JSON.stringify(manifest);
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  await page.unroute(REGISTRY);
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [{
    schema: 1, kind: "lesson", id: "test/registry-demo", name: "registry-demo", title: "Registry demo",
    summary: "Discovered without being bundled into Studio.", publisher: "test", version: "0.1.0",
    status: "preview", verified: false, manifest: "https://registry-lesson.example.test/lesson.json", manifestSha256,
    publishedAt: "2026-08-27", compatibility: { biolang: ">=1.5.0", studio: ">=0.1.0", runtimes: ["browser"] },
    categories: ["teaching"], tags: ["test"], sourceRepository: "https://github.com/example/registry-demo", licence: "MIT", validation: "fixture"
  }] } }));
  await page.route("https://registry-lesson.example.test/lesson.json", route => route.fulfill({ contentType: "application/json", body: manifestText }));
  await page.route("https://registry-lesson.example.test/lesson.bln", route => route.fulfill({ contentType: "text/plain", body: "# Registry lesson\n\n```biolang\nlet tiny = read_csv(\"tiny.csv\")\nnrow(tiny)\n```\n" }));
  await page.route("https://registry-lesson.example.test/tiny.csv", route => route.fulfill({ contentType: "text/csv", body: "x,y\n1,2\n3,4\n" }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Registry", exact: true })).toBeVisible();
  await expect(page.getByLabel("Registry entry details").getByRole("heading", { name: "Registry demo" })).toBeVisible();
  await page.unroute(REGISTRY);
  await page.route(REGISTRY, route => route.abort());
  await page.unroute(REGISTRY_FALLBACK);
  await page.route(REGISTRY_FALLBACK, route => route.abort());
  await page.reload();
  await expect(page.getByText("offline cache")).toBeVisible();
  await expect(page.getByLabel("Registry entry details").getByRole("heading", { name: "Registry demo" })).toBeVisible();
  await page.getByRole("button", { name: "Install Registry demo" }).click();
  await expect(page.getByText(/checksum-verified and installed/)).toBeVisible();
  await expect(page.locator('input[aria-label="Notebook name"]')).toHaveValue("registry-demo.bln");
  await page.getByRole("button", { name: "Prepare" }).click();
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible();
  await page.locator("article.cell-code").getByTitle("Run this cell and any prerequisites").click();
  await expect(page.locator("article.cell-code .result")).toContainText("2");
  await page.getByTitle("Remove Registry demo").click();
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await expect(page.getByLabel("Registry entry details").getByRole("heading", { name: "Registry demo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install Registry demo" })).toBeVisible();
});

test("rejects a registry lesson when its manifest checksum differs", async ({ page }) => {
  await page.unroute(REGISTRY);
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [{
    schema: 1, kind: "lesson", id: "test/tampered", name: "tampered", title: "Tampered lesson",
    summary: "Negative security fixture.", publisher: "test", version: "0.1.0", status: "preview", verified: false,
    manifest: "https://registry-lesson.example.test/tampered.json", manifestSha256: "0".repeat(64),
    publishedAt: "2026-08-27", compatibility: { runtimes: ["browser"] }, categories: ["teaching"], tags: ["test"],
    sourceRepository: "https://github.com/example/tampered", licence: "MIT", validation: "fixture"
  }] } }));
  await page.route("https://registry-lesson.example.test/tampered.json", route => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await page.getByRole("button", { name: "Install Tampered lesson" }).click();
  await expect(page.getByText(/failed its registry SHA-256 check/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Install Tampered lesson" })).toBeVisible();
});

test("searches and prepares a registered dataset on demand", async ({ page }) => {
  const datasetManifest = {
    schema: 1, kind: "dataset", id: "test/tiny-cells", version: "1.0.0", title: "Tiny cells",
    summary: "A tiny browser fixture.", description: "Synthetic tabular data for registry download testing.",
    categories: ["single-cell"], tags: ["PBMC"], modalities: ["RNA"], organisms: ["Homo sapiens"],
    provider: "oriclabs/direct-https", access: { kind: "public", requiresAcceptance: false },
    source: { landingPage: "https://datasets.example.test/tiny", citation: "Synthetic fixture", licence: "CC0", rights: "Test data" },
    files: [{ id: "cells", title: "Tiny cells CSV", path: "tiny-cells.csv", url: "https://datasets.example.test/tiny.csv",
      bytes: 12, sha256: "2a2b86e74ffd5e6a9b75e52a105cf9d02920837179f8e8961aa15411d380f7a3",
      mediaType: "text/csv", format: "csv", compression: "none", role: "primary", reader: "read_csv" }]
  };
  const manifestText = JSON.stringify(datasetManifest);
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  await page.unroute(REGISTRY);
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [{
    schema: 1, kind: "dataset", id: "test/tiny-cells", name: "tiny-cells", title: "Tiny cells",
    summary: "A tiny browser fixture.", publisher: "test", version: "1.0.0", status: "stable", verified: true,
    manifest: "https://datasets.example.test/dataset.json", manifestSha256, publishedAt: "2026-08-28",
    compatibility: { runtimes: ["browser", "desktop", "somer", "cli"] }, categories: ["single-cell"], tags: ["PBMC"],
    sourceRepository: "https://github.com/example/tiny-cells", licence: "CC0", validation: "registry-verified",
    dataset: { provider: "oriclabs/direct-https", access: "public", formats: ["csv"], modalities: ["RNA"], organisms: ["Homo sapiens"], fileCount: 1, totalBytes: 12 }
  }] } }));
  await page.route("https://datasets.example.test/dataset.json", route => route.fulfill({ contentType: "application/json", body: manifestText }));
  await page.route("https://datasets.example.test/tiny.csv", route => route.fulfill({ contentType: "text/csv", body: "x,y\n1,2\n3,4\n" }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await expect(page).toHaveURL(/view=registry/);
  await page.getByRole("tab", { name: /Datasets/ }).click();
  await page.getByLabel("Registry search").fill("sapiens csv");
  await expect(page).toHaveURL(/kind=dataset/);
  await expect(page).toHaveURL(/q=sapiens(?:\+|%20)csv/);
  await expect(page.getByLabel("Registry entry details").getByRole("heading", { name: "Tiny cells" })).toBeVisible();
  await page.getByRole("button", { name: "Prepare Tiny cells" }).click();
  await expect(page.getByText(/checksum-verified, cached, and attached/)).toBeVisible();
});
