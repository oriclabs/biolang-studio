import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

const studioUrl = process.env.STUDIO_URL || "https://oriclabs.com/biolang-studio/";
const registryUrl = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";
const lessonTitle = "Essential statistics with NHANES";

const registryResponse = await fetch(registryUrl, { cache: "no-store" });
if (!registryResponse.ok) throw new Error(`Registry HTTP ${registryResponse.status}`);
const registry = await registryResponse.json();
const entry = registry.entries?.find(item => item.id === "oriclabs/bdsr-essential-statistics");
if (!entry) throw new Error("Published registry does not contain the BDSR lesson.");
const manifestResponse = await fetch(entry.manifest, { cache: "no-store" });
if (!manifestResponse.ok) throw new Error(`Manifest HTTP ${manifestResponse.status}`);
const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
if (manifestSha256 !== entry.manifestSha256) throw new Error(`Published manifest checksum mismatch: ${manifestSha256}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const browserErrors = [];
page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
page.on("pageerror", error => browserErrors.push(error.message));

try {
  await page.goto(studioUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator(".status-ready").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: `Install ${lessonTitle}` }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: `Install ${lessonTitle}` }).click();
  await page.locator('input[aria-label="Notebook name"]').waitFor({ state: "visible" });
  if (await page.locator('input[aria-label="Notebook name"]').inputValue() !== "bdsr-essential-statistics.bln") throw new Error("Published lesson notebook did not load.");
  await page.getByText("Stephen D. Turner", { exact: false }).first().waitFor();

  const datasetCount = await page.getByRole("button", { name: "Prepare" }).count();
  if (datasetCount !== 2) throw new Error(`Expected 2 opt-in datasets, found ${datasetCount}.`);
  for (let index = 0; index < datasetCount; index++) {
    await page.getByRole("button", { name: "Prepare" }).first().click();
    await page.getByRole("button", { name: "Ready" }).nth(index).waitFor({ timeout: 60_000 });
  }

  await page.getByRole("button", { name: /Run all/ }).click();
  await page.getByText(/Finished through cell/).waitFor({ timeout: 120_000 });
  const executionErrors = await page.locator(".result-error").count();
  const plots = await page.locator("iframe.plot-frame").count();
  if (executionErrors) throw new Error(`${executionErrors} notebook cells failed.`);
  if (plots < 10) throw new Error(`Expected at least 10 BioLang plots, rendered ${plots}.`);

  await page.getByTitle(`Remove ${lessonTitle}`).click();
  await page.getByRole("button", { name: `Install ${lessonTitle}` }).waitFor();
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(" | ")}`);
  console.log(JSON.stringify({ studioUrl, registryEntries: registry.entries.length, manifestSha256, preparedDatasets: datasetCount, renderedPlots: plots, removedCleanly: true }, null, 2));
} catch (error) {
  const state = await page.locator(".status").textContent().catch(() => "missing");
  const notice = await page.locator(".notice").textContent().catch(() => "missing");
  throw new Error(`${error instanceof Error ? error.message : error}; kernel=${state}; notice=${notice}; browser=${browserErrors.join(" | ") || "none"}`);
} finally {
  await browser.close();
}
