import { expect, test } from "@playwright/test";
import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRY = "https://registry.lang.bio/v1/index.json";
const REGISTRY_FALLBACK = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";

test.beforeEach(async ({ page }) => {
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [] } }));
  await page.route(REGISTRY_FALLBACK, route => route.fulfill({ json: { schema: 1, entries: [] } }));
});

test("renders a print-ready A4 report with code, results, and a plot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "+ Code" }).click();
  const plotCell = page.locator("article.cell-code").last();
  await plotCell.locator("textarea.code-editor").fill('histogram([12, 14, 15, 15, 16, 19, 28], {bins: 5, format: "svg", title: "Teaching distribution"})');
  await plotCell.getByRole("button", { name: /Run cell/ }).click();
  await expect(plotCell.locator('iframe[title="BioLang plot"]')).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /Print \/ Save PDF/ }).check();
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open print view" }).click();
  const report = await popupEvent;
  await expect(report.locator("article.report")).toBeVisible();
  await expect(report.locator("figure svg")).toBeVisible();
  await expect(report.locator(".code").last()).toContainText("histogram");

  const directory = resolve("tmp/pdfs"); mkdirSync(directory, { recursive: true });
  const output = resolve(directory, "biolang-studio-report-qa.pdf");
  await report.emulateMedia({ media: "print" });
  await report.screenshot({ path: resolve(directory, "biolang-studio-report-print-preview.png"), fullPage: true });
  await report.pdf({ path: output, format: "A4", printBackground: true, preferCSSPageSize: true });
  expect(statSync(output).size).toBeGreaterThan(10_000);
});
