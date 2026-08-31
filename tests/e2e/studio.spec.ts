import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

const REGISTRY = "https://registry.lang.bio/v1/index.json";
const REGISTRY_FALLBACK = "https://raw.githubusercontent.com/oriclabs/biolang-registry/main/registry/v1/index.json";

test.beforeEach(async ({ page }) => {
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [] } }));
  await page.route(REGISTRY_FALLBACK, route => route.fulfill({ json: { schema: 1, entries: [] } }));
});

test("switches and remembers the Studio color theme", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Color theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(8, 13, 24)");
  expect(await page.locator("article.cell").first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(17, 24, 39)");
  await page.reload();
  await expect(page.getByLabel("Color theme")).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("shows every existing lesson cell as paired BioLang and JavaScript", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?lang=js");
  const firstCell = page.locator("article.cell-code").first();
  await expect(firstCell.getByRole("tab", { name: "JavaScript" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Notebook code language")).toHaveValue("javascript");
  await expect(firstCell.getByLabel("JavaScript equivalent for cell 2")).toContainText("await bl.run(");
  await expect(firstCell.getByLabel("JavaScript equivalent for cell 2")).toContainText("let measurements");
  await firstCell.getByRole("button", { name: /Copy JavaScript code/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("await bl.run(");

  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: /Run all · JS/ }).click();
  await expect(page.locator("article.cell-code").nth(1).locator(".result")).toContainText("15", { timeout: 30_000 });
  await expect(page.getByText(/using JavaScript compiled to BioLang/)).toBeVisible();

  await firstCell.getByRole("tab", { name: "BioLang" }).click();
  await expect(page.getByLabel("Notebook code language")).toHaveValue("biolang");
  await expect(page.locator("textarea.code-editor").first()).toContainText("let measurements");
  await page.goto("/");
  await expect(page.locator("article.cell-code").first().getByRole("tab", { name: "BioLang" })).toHaveAttribute("aria-selected", "true");
});

test("creates an editable task-first statistics notebook", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Guided stats" }).click();
  await expect(page.getByRole("heading", { name: "New guided statistics notebook" })).toBeVisible();
  await page.getByLabel("Question").selectOption("paired");
  await page.getByLabel("Attached CSV path").fill("patient-measurements.csv");
  await page.getByLabel("Columns, in the stated order").fill("baseline,followup");
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByLabel("Notebook name")).toHaveValue("compare-matched-measurements.bln");
  await expect(page.locator("textarea.code-editor").first()).toContainText('read_csv("patient-measurements.csv")');
  await expect(page.locator("textarea.code-editor").nth(1)).toContainText('stat.paired_change(data["baseline"], data["followup"], {method: "paired_t"})');
});

test("runs prerequisite cells in the isolated WASM kernel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("BioLang Studio")).toBeVisible();
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").nth(1).getByRole("button", { name: /Run cell/ }).click();
  await expect(page.locator("article.cell-code").nth(1).locator(".result")).toContainText("15", { timeout: 30_000 });
  const result = page.locator("article.cell-code").nth(1).locator(".result");
  await expect(result.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  await expect(result.getByRole("row", { name: /mean 17/ })).toBeVisible();
  await result.getByRole("button", { name: "JSON" }).click();
  await expect(result.locator("pre")).toContainText('"median": 15');
  await expect(page.getByText(/Earlier code cells were run when needed/)).toBeVisible();
  await expect(page.getByText(/2 runnable · all current/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run again cell 4" })).toBeVisible();
  const firstCode = page.locator("article.cell-code").first().locator("textarea.code-editor");
  await firstCode.fill(`${await firstCode.inputValue()} `);
  await expect(page.getByRole("button", { name: "Rerun required cell 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rerun required cell 4" })).toBeVisible();
  await expect(page.getByText(/2 runnable · 0 current/)).toBeVisible();
});

test("supports notebook keyboard execution, copying, indentation, and accessible dialog dismissal", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  const first = page.locator("textarea.code-editor").first();
  await first.fill("let shortcut_value = 41\nshortcut_value + 1");
  await first.press("Control+Enter");
  await expect(page.locator("article.cell-code").first().locator(".result")).toContainText("42", { timeout: 30_000 });
  await page.locator("article.cell-code").first().getByRole("button", { name: /Copy code from cell/ }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, "\n")).toBe("let shortcut_value = 41\nshortcut_value + 1");
  await expect(page.getByText(/Copied BioLang code from cell/)).toBeVisible();
  await first.press("End");
  await first.press("Tab");
  await expect(first).toHaveValue(/  $/);

  await page.getByRole("button", { name: "Guided stats" }).click();
  await expect(page.getByRole("dialog", { name: "New guided statistics notebook" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New guided statistics notebook" })).toHaveCount(0);
});

test("keeps BioLang operators literal and opens external lesson links separately", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Explanation" }).click();
  const editor = page.locator("textarea.markdown-editor").last();
  await editor.fill("Use `values |> summary()` and read [the reference](https://example.org/reference).");
  await editor.blur();
  const rendered = page.locator("article.cell-markdown").last();
  await expect(rendered.getByRole("link", { name: "the reference" })).toHaveAttribute("target", "_blank");
  await expect(rendered.getByRole("link", { name: "the reference" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(await rendered.locator("code").evaluate(element => getComputedStyle(element).fontVariantLigatures)).toContain("none");
  await expect(rendered.locator("code")).toHaveText("values |> summary()");
});

test("exports readable reports and reproducible BioLang handoffs", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").last().getByRole("button", { name: /Run cell/ }).click();
  await expect(page.getByText(/Finished through cell/)).toBeVisible();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const htmlEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export HTML" }).click();
  const htmlDownload = await htmlEvent;
  expect(htmlDownload.suggestedFilename()).toMatch(/\.html$/);
  const htmlStream = await htmlDownload.createReadStream(); const htmlChunks: Buffer[] = [];
  for await (const chunk of htmlStream) htmlChunks.push(Buffer.from(chunk));
  const html = Buffer.concat(htmlChunks).toString("utf8");
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("font-variant-ligatures:none");
  expect(html).not.toContain('<script src=');

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /Markdown bundle/ }).check();
  const markdownEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Markdown ZIP" }).click();
  const markdownDownload = await markdownEvent;
  expect(markdownDownload.suggestedFilename()).toMatch(/-markdown\.zip$/);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /Notebook \(\.bln\)/ }).check();
  const notebookEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download notebook" }).click();
  expect((await notebookEvent).suggestedFilename()).toMatch(/\.bln$/);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /Executable script/ }).check();
  const scriptEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download script" }).click();
  const scriptDownload = await scriptEvent;
  expect(scriptDownload.suggestedFilename()).toMatch(/\.bl$/);
  const scriptStream = await scriptDownload.createReadStream(); const scriptChunks: Buffer[] = [];
  for await (const chunk of scriptStream) scriptChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(scriptChunks).toString("utf8")).toContain("Generated by BioLang Studio");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /CLI project/ }).check();
  const projectEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CLI project" }).click();
  const projectDownload = await projectEvent;
  expect(projectDownload.suggestedFilename()).toMatch(/-cli\.zip$/);
  const projectStream = await projectDownload.createReadStream(); const projectChunks: Buffer[] = [];
  for await (const chunk of projectStream) projectChunks.push(Buffer.from(chunk));
  const projectArchive = Buffer.concat(projectChunks).toString("utf8");
  expect(projectArchive).toContain("lesson-data.json");
  expect(projectArchive).toContain("PROVENANCE.md");
});

test("renders plots responsively with resize and export actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "+ Code" }).click();
  const cell = page.locator("article.cell-code").last();
  await cell.locator("textarea.code-editor").fill('histogram([18, 19, 20, 21, 22, 24, 27, 31], {bins: 4, format: "svg", title: "Responsive BMI"})');
  await cell.getByRole("button", { name: /Run cell/ }).click();
  const plot = cell.locator(".plot-view");
  await expect(plot.locator('iframe[title="BioLang plot"]')).toBeVisible({ timeout: 30_000 });
  await expect(plot.getByRole("button", { name: "Expand" })).toBeVisible();
  await expect(plot.getByRole("button", { name: "Export SVG" })).toBeVisible();
  await expect(plot.getByRole("button", { name: "Save PNG" })).toBeVisible();
  expect(await plot.locator(".plot-inline").evaluate(element => getComputedStyle(element).resize)).toBe("vertical");
  const frame = page.frameLocator('iframe[title="BioLang plot"]');
  expect(await frame.locator("body").evaluate(body => body.scrollWidth <= body.clientWidth && body.scrollHeight <= body.clientHeight)).toBe(true);
  const svgDownload = page.waitForEvent("download");
  await plot.getByRole("button", { name: "Export SVG" }).click();
  expect((await svgDownload).suggestedFilename()).toBe("responsive-bmi.svg");
  const pngDownload = page.waitForEvent("download");
  await plot.getByRole("button", { name: "Save PNG" }).click();
  expect((await pngDownload).suggestedFilename()).toBe("responsive-bmi.png");
  await plot.getByRole("button", { name: "Expand" }).click();
  await expect(page.getByRole("dialog", { name: "Expanded plot" })).toBeVisible();
  await page.getByRole("button", { name: "Close expanded plot" }).click();
});

test("stops at an inline error and offers retry or delete", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "+ Code" }).click();
  await page.getByRole("button", { name: "+ Code" }).click();
  const code = page.locator("article.cell-code");
  await code.nth(0).locator("textarea.code-editor").fill("does_not_exist()");
  await code.nth(1).locator("textarea.code-editor").fill("let should_not_run = 42");
  await code.nth(1).getByRole("button", { name: /Run cell/ }).click();
  await expect(code.nth(0).locator(".result-error")).toHaveAttribute("role", "alert");
  await expect(code.nth(0).getByRole("button", { name: "Retry cell 2" })).toBeVisible();
  await expect(code.nth(1).locator(".result")).toHaveCount(0);
  await expect(page.getByText(/Stopped at cell 2/)).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await code.nth(0).getByRole("button", { name: "Delete cell 2" }).click();
  await expect(page.locator("article.cell-code")).toHaveCount(1);
});

test("exports a backend-disclosed, checksum-pinned run record", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").first().getByRole("button", { name: /Run cell/ }).click();
  await expect(page.getByText(/Finished through cell/)).toBeVisible();

  await page.getByText("Workspace", { exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export latest run record" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.run\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(record).toMatchObject({ schema: 1, kind: "biolang-studio-run", success: true, runtime: { runtime: "browser" } });
  expect(record.notebook.sourceLanguage).toBe("biolang");
  expect(record.notebook.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(record.notebook.frontendSourceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(record.notebook.executedSourceSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("uses native document open, atomic save metadata, recents, and external reload", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { __nativeCalls: Array<{ command: string; payload: any }>; __externalChanged: boolean; __diskSource: string };
    state.__nativeCalls = []; state.__externalChanged = false; state.__diskSource = "# Native notebook\n\n```biolang\nlet native_value = 1\n```\n";
    window.__BIOLANG_DESKTOP__ = { invoke: async <T,>(command: string, payload?: unknown) => {
      state.__nativeCalls.push({ command, payload });
      if (command === "studio_open_document") return { path: "C:\\work\\native-analysis.bln", filename: "native-analysis.bln", contents: state.__diskSource, size: state.__diskSource.length, sha256: state.__externalChanged ? "c".repeat(64) : "a".repeat(64), modifiedMs: 10 } as T;
      if (command === "studio_save_document") {
        const request = (payload as any).request;
        state.__diskSource = request.contents;
        return { status: "saved", path: "C:\\work\\native-analysis.bln", document: { path: "C:\\work\\native-analysis.bln", filename: "native-analysis.bln", contents: request.contents, size: request.contents.length, sha256: "b".repeat(64), modifiedMs: 20 } } as T;
      }
      if (command === "studio_document_status") return { exists: true, changed: state.__externalChanged, currentSha256: state.__externalChanged ? "c".repeat(64) : (payload as any).expectedSha256, modifiedMs: 30 } as T;
      throw new Error(`Unexpected native command ${command}`);
    }};
  });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByLabel("Notebook name")).toHaveValue("native-analysis.bln");
  await page.locator("textarea.code-editor").fill("let native_value = 2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved native-analysis.bln atomically.")).toBeVisible();
  const saveRequest = await page.evaluate(() => (window as any).__nativeCalls.find((call: any) => call.command === "studio_save_document").payload.request);
  expect(saveRequest.expectedSha256).toBe("a".repeat(64));

  await page.locator("details.workspace-file-menu > summary").click();
  await expect(page.getByText("Recent Desktop files")).toBeVisible();
  await expect(page.getByRole("button", { name: "native-analysis.bln notebook" })).toBeVisible();
  await page.locator("details.workspace-file-menu > summary").click();

  await page.evaluate(() => { (window as any).__externalChanged = true; (window as any).__diskSource = "# Reloaded\n\n```biolang\nlet native_value = 3\n```\n"; window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("Changed outside Studio", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload notebook" }).click();
  await expect(page.locator("textarea.code-editor")).toHaveValue("let native_value = 3");
});

test("cancels native execution and namespaces kernel disposal across notebook tabs", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { __nativeCalls: Array<{ command: string; payload: any }>; __rejectExecute?: (error: Error) => void };
    state.__nativeCalls = [];
    window.__BIOLANG_DESKTOP__ = { invoke: async <T,>(command: string, payload?: unknown) => {
      state.__nativeCalls.push({ command, payload });
      if (command === "kernel_initialize") return {} as T;
      if (command === "kernel_has_attachment") return false as T;
      if (command === "kernel_variables") return { status: "ok", output: "", durationMs: 0, environment: { variables: [], totalBytes: 0 } } as T;
      if (command === "kernel_execute") return await new Promise<T>((_resolve, reject) => { state.__rejectExecute = reject; });
      if (command === "kernel_cancel") { state.__rejectExecute?.(new Error("cancelled")); return undefined as T; }
      if (command === "kernel_dispose") return undefined as T;
      if (command === "get_environment") return { blVersion: "BioLang 1.5.0", platform: "windows", architecture: "x86_64" } as T;
      throw new Error(`Unexpected native command ${command}`);
    }};
  });
  page.on("dialog", dialog => void dialog.accept());
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("combobox", { name: "Kernel", exact: true }).selectOption("desktop");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").first().getByRole("button", { name: /Run cell/ }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText(/next run will replay this notebook/)).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  const calls = await page.evaluate(() => (window as any).__nativeCalls);
  const initialized = calls.filter((call: any) => call.command === "kernel_initialize").map((call: any) => call.payload.namespace);
  const disposed = calls.filter((call: any) => call.command === "kernel_dispose").map((call: any) => call.payload.namespace);
  expect(initialized).toHaveLength(2);
  expect(new Set(initialized).size).toBe(2);
  expect(disposed).toContain(initialized[0]);
});

test("inspects variables in bounded pages and exports a small value", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  const values = Array.from({ length: 25 }, (_, index) => index + 1).join(", ");
  const longValue = "A".repeat(300);
  const cell = page.locator("article.cell-code").first();
  await cell.locator("textarea.code-editor").fill(`let many = [${values}]\nlet exact = ["${longValue}"]`);
  await cell.getByRole("button", { name: /Run cell/ }).click();

  await page.locator("details.variables-disclosure > summary").click();
  const variable = page.locator(".variable-item").filter({ hasText: "many" });
  await expect(variable).toContainText("25 items");
  await variable.getByTitle("Inspect many").click();
  await expect(variable.locator(".variable-page-status")).toContainText("20 of 25 rows loaded");
  await variable.getByRole("button", { name: "Load 20 more" }).click();
  await expect(variable.locator(".variable-page-status")).toContainText("25 of 25 rows loaded");

  const exact = page.locator(".variable-item").filter({ hasText: "exact" });
  await exact.getByLabel("Actions for exact").click();
  const downloadEvent = page.waitForEvent("download");
  await exact.getByRole("button", { name: "Export value" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("exact.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual([longValue]);
});

test("authors, runs, and collapses an optional lesson step", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "+ Step" }).click();
  const editor = page.locator("textarea.markdown-editor").last();
  await editor.fill('<!-- bl:step title="A grouped calculation" -->\n\nSet a value and inspect the result.\n\n```biolang\nlet grouped = 6\ngrouped * 7\n```\n\nThe result should be 42.\n\n<!-- /bl:step -->');
  await page.locator(".document-head").click();

  const step = page.locator(".lesson-step").last();
  await expect(step.getByText("A grouped calculation")).toBeVisible();
  await step.getByRole("button", { name: "Run step" }).click();
  await expect(step.locator("article.cell-code .result")).toContainText("42", { timeout: 30_000 });

  const variables = page.locator("details.variables-disclosure");
  await expect(variables).not.toHaveAttribute("open", "");
  await step.getByRole("button", { name: "Collapse A grouped calculation" }).click();
  await expect(step.locator("article.cell")).toHaveCount(0);
  await step.getByRole("button", { name: "Expand A grouped calculation" }).click();
  await expect(step.locator("article.cell")).toHaveCount(3);
});

test("keeps notebook variables isolated while sharing an explicit data attachment", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").first().getByRole("button", { name: /Run cell/ }).click();
  await expect(page.locator("details.variables-disclosure summary small")).not.toHaveText("0");

  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "shared.csv", mimeType: "text/csv", buffer: Buffer.from("x\n1\n") });
  const attachment = page.locator(".attached-data").filter({ hasText: "shared.csv" });
  await attachment.getByRole("button", { name: "Share", exact: true }).click();
  await expect(attachment).toContainText("all notebooks");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("tab", { name: /untitled-2\.bln/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".attached-data").filter({ hasText: "shared.csv" })).toContainText("all notebooks");
  await expect(page.locator("details.variables-disclosure summary small")).toHaveText("0");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });

  await page.getByRole("button", { name: "+ Code" }).click();
  await page.locator("textarea.code-editor").last().fill("measurements");
  await page.locator("article.cell-code").last().getByRole("button", { name: /Run cell/ }).click();
  await expect(page.locator("article.cell-code").last().locator(".result-error")).toContainText(/measurements|variable/i);

  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".attached-data").filter({ hasText: "shared.csv" })).toContainText("all notebooks");
});

test("publishes a checksum-pinned output for a later notebook", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").first().getByRole("button", { name: /Run cell/ }).click();
  await expect(page.locator("details.variables-disclosure summary small")).not.toHaveText("0");
  await page.locator("details.variables-disclosure > summary").click();
  const variable = page.locator(".variable-item").filter({ hasText: "measurements" });
  await variable.locator(".variable-actions > summary").click();
  page.on("dialog", async dialog => {
    if (dialog.type() === "prompt") await dialog.accept("outputs/measurements.json");
    else await dialog.accept();
  });
  await variable.getByRole("button", { name: "Publish output…" }).click();

  const output = page.locator(".attached-data").filter({ hasText: "outputs/measurements.json" });
  await expect(output).toContainText("all notebooks");
  await expect(output).toContainText("output from untitled.bln");
  await expect(page.getByText(/Published measurements as outputs\/measurements\.json/)).toBeVisible();

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".attached-data").filter({ hasText: "outputs/measurements.json" })).toContainText("all notebooks");
});

test("exports, imports, closes, and reopens a multi-notebook workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByLabel("Workspace name").fill("Two notebook study");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Notebook name").fill("second.bln");

  const downloadEvent = page.waitForEvent("download");
  await page.getByText("Workspace", { exact: true }).click();
  await page.getByRole("button", { name: "Export .blw" }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const workspaceBytes = Buffer.concat(chunks);
  const workspace = JSON.parse(workspaceBytes.toString("utf8"));
  expect(workspace.notebooks).toHaveLength(2);
  expect(JSON.stringify(workspace)).not.toContain('"contents"');

  const saveEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saveEvent;
  await page.getByRole("button", { name: "Close second.bln" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.getByRole("button", { name: "Reopen closed" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);

  await page.locator('input[accept*=".blw"]').setInputFiles({ name: "study.blw", mimeType: "application/json", buffer: workspaceBytes });
  await expect(page.getByLabel("Workspace name")).toHaveValue("Two notebook study");
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("reviews an independent HTTPS file before downloading and records provenance", async ({ page }) => {
  const contents = Buffer.from("gene,value\nTP53,3\n");
  let requests = 0;
  await page.route("https://data.example.test/remote.csv", async route => {
    requests += 1;
    await route.fulfill({ status: 200, contentType: "text/csv", headers: { "access-control-allow-origin": "*" }, body: contents });
  });
  await page.goto("/");
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "From URL…" }).click();
  await page.getByLabel("HTTPS source URL").fill("http://data.example.test/remote.csv");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add data from URL" }).getByRole("alert")).toContainText("must use HTTPS");
  expect(requests).toBe(0);
  await page.getByLabel("HTTPS source URL").fill("https://data.example.test/remote.csv");
  await expect(page.getByLabel("Mount path")).toHaveValue("remote.csv");
  await page.getByLabel(/Expected bytes/).fill(String(contents.byteLength));
  await page.getByRole("button", { name: "Review", exact: true }).click();
  expect(requests).toBe(0);
  await expect(page.getByText("Review remote data")).toBeVisible();
  await expect(page.locator(".url-review")).toContainText("No published checksum supplied");
  await page.getByRole("button", { name: "Download and attach" }).click();
  await expect(page.locator(".attached-data").filter({ hasText: "remote.csv" })).toContainText("HTTPS source");
  expect(requests).toBe(1);

  const downloadEvent = page.waitForEvent("download");
  await page.getByText("Workspace", { exact: true }).click();
  await page.getByRole("button", { name: "Export .blw" }).click();
  const stream = await (await downloadEvent).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const workspace = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(workspace.schema).toBe(3);
  expect(workspace.attachments[0].source).toMatchObject({ kind: "url", url: "https://data.example.test/remote.csv", sourceBytes: contents.byteLength });
  expect(workspace.attachments[0].source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(workspace.attachments[0]).not.toHaveProperty("contents");
});

test("recovers a valid backup when the primary session is interrupted", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForTimeout(1_000);
  await page.getByLabel("Workspace name").fill("Recovery checkpoint");
  await page.waitForTimeout(1_000);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspaces = await root.getDirectoryHandle("workspaces");
    const primary = await workspaces.getFileHandle("__studio-session-v1.json");
    const writable = await primary.createWritable();
    await writable.write("{interrupted");
    await writable.close();
  });
  await page.reload();
  await expect(page.getByText(/Recovered 2 notebooks from the backup session copy/)).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("clears cached data without deleting notebook references", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "cached.csv", mimeType: "text/csv", buffer: Buffer.from("x\n1\n") });
  await page.locator("details.storage-disclosure summary").click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Clear cached data" }).click();
  const attachment = page.locator(".attached-data").filter({ hasText: "cached.csv" });
  await expect(attachment).toContainText("needs data");
  await expect(attachment.getByRole("button", { name: "Reattach" })).toBeVisible();
  await expect(page.locator("article.cell")).not.toHaveCount(0);
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
  await expect(page.getByTitle("Open External demo")).toBeVisible();
  const installedLesson = page.locator(".lesson-row").filter({ hasText: "External demo" });
  await expect(installedLesson.locator(".lesson-meta")).toHaveText("Local");
  await expect(installedLesson.locator(".lesson-link")).not.toContainText("Installed only when requested.");
  await installedLesson.getByRole("button", { name: "About External demo" }).click();
  await expect(page.getByRole("dialog", { name: "About External demo" })).toContainText("Installed only when requested.");
  await page.getByRole("dialog", { name: "About External demo" }).getByRole("button", { name: "Close" }).click();
  await expect(page.locator('input[aria-label="Notebook name"]')).toHaveValue("external-demo.bln");
  await expect(page.getByText("Prepare data before running", { exact: true })).toBeVisible();
  await expect(page.locator(".status")).toHaveText("ready", { timeout: 30_000 });
  await page.locator("article.cell-code").getByRole("button", { name: /Run cell/ }).click();
  await expect(page.getByText(/Prepare the lesson data before running/)).toBeVisible();
  await expect(page.locator("article.cell-code .result")).toHaveCount(0);
  await page.getByRole("button", { name: /Prepare & run all/ }).click();
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible();
  await expect(page.locator("article.cell-code .result")).toContainText("2");
  await page.getByTitle("Remove External demo").click();
  await expect(page.getByText("No lesson packages installed.")).toBeVisible();
});

test("opens a lesson collection as one tab with stateful selectable sections", async ({ page }) => {
  await page.route("https://lessons.example.test/biomedical/lesson.json", route => route.fulfill({
    json: {
      schema: 2, id: "biomedical-series", title: "Biomedical series", summary: "Two connected lessons.",
      runtime: "browser", estimatedMemoryMb: 2,
      source: { title: "CC BY source", url: "https://lessons.example.test/source", note: "Adapted" },
      datasets: [{
        id: "tiny", title: "Tiny shared data", path: "tiny.csv", url: "https://lessons.example.test/biomedical/tiny.csv",
        bytes: 12, sha256: "2a2b86e74ffd5e6a9b75e52a105cf9d02920837179f8e8961aa15411d380f7a3",
        mediaType: "text/csv", source: "Synthetic fixture", citation: "Test only", rights: "Test only"
      }], tags: ["statistics"],
      lessons: [
        { id: "risk", title: "Risk", summary: "Compare risks.", entry: "01-risk.bln" },
        { id: "trials", title: "Trials", summary: "Plan trials.", entry: "02-trials.bln" },
      ],
    },
  }));
  await page.route("https://lessons.example.test/biomedical/01-risk.bln", route => route.fulfill({ contentType: "text/plain", body: "# Risk\n\n```biolang\n1 + 1\n```\n" }));
  await page.route("https://lessons.example.test/biomedical/02-trials.bln", route => route.fulfill({ contentType: "text/plain", body: "# Trials\n\n```biolang\n2 + 2\n```\n" }));
  await page.route("https://lessons.example.test/biomedical/tiny.csv", route => route.fulfill({ contentType: "text/csv", body: "x,y\n1,2\n3,4\n" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Add from manifest URL" }).click();
  await page.getByLabel("Manifest URL").fill("https://lessons.example.test/biomedical/lesson.json");
  await page.getByRole("button", { name: "Add lesson", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Biomedical series/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "risk.bln" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "trials.bln" })).toHaveCount(0);
  await expect(page.getByText(/Biomedical series was added as one lesson with 2 selectable sections/)).toBeVisible();
  const sectionSelector = page.getByLabel("Lesson section", { exact: true });
  await expect(sectionSelector).toHaveValue("risk");
  await page.getByRole("button", { name: "Prepare", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeVisible();
  await page.locator("article.cell-code").getByRole("button", { name: /Run cell/ }).click();
  await expect(page.locator("article.cell-code .result")).toContainText("2");
  await sectionSelector.selectOption("trials");
  await expect(page.getByRole("heading", { name: "Trials" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeVisible();
  await sectionSelector.selectOption("risk");
  await expect(page.locator("article.cell-code .result")).toContainText("2");
  await page.getByTitle("Remove Biomedical series").click();
  await expect(page.getByText("No lesson packages installed.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "risk.bln" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "trials.bln" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Inspired by CC BY source/ })).toHaveCount(0);
});

test("discovers, verifies, runs, and removes a registry lesson", async ({ page }) => {
  const manifest = {
    schema: 1, id: "registry-demo", title: "Registry demo", summary: "Discovered without being bundled into Studio.",
    entry: "lesson.bln", runtime: "browser", estimatedMemoryMb: 1,
    source: { title: "Test fixture", url: "https://registry-lesson.example.test", note: "Synthetic" },
    series: { id: "test-methods", title: "Test methods book", url: "https://registry-lesson.example.test/book", order: 4, chapter: "Chapter 4 · Registry lessons" },
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
    categories: ["teaching"], tags: ["test"], sourceRepository: "https://github.com/example/registry-demo", licence: "MIT", validation: "fixture",
    series: { id: "test-methods", title: "Test methods book", url: "https://registry-lesson.example.test/book", order: 4, chapter: "Chapter 4 · Registry lessons" }
  }] } }));
  await page.route("https://registry-lesson.example.test/lesson.json", route => route.fulfill({ contentType: "application/json", body: manifestText }));
  await page.route("https://registry-lesson.example.test/lesson.bln", route => route.fulfill({ contentType: "text/plain", body: "# Registry lesson\n\n```biolang\nlet tiny = read_csv(\"tiny.csv\")\nnrow(tiny)\n```\n" }));
  await page.route("https://registry-lesson.example.test/tiny.csv", route => route.fulfill({ contentType: "text/csv", body: "x,y\n1,2\n3,4\n" }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Registry", exact: true })).toBeVisible();
  const registryDetail = page.getByLabel("Registry entry details");
  await expect(registryDetail.getByRole("heading", { name: "Registry demo" })).toBeVisible();
  await expect(registryDetail.getByText("Available", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Lessons/ }).click();
  const registryCollection = page.locator("details.registry-series").filter({ hasText: "Test methods book" });
  await expect(registryCollection.getByText("1 lesson", { exact: true })).toBeVisible();
  await expect(registryCollection.getByText("Chapter 4 · Registry lessons", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /All/ }).click();
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
  await expect(page.locator("aside.sidebar details.lesson-series summary").getByText("Test methods book")).toBeVisible();
  await page.locator("article.cell-code textarea").fill('# local note\nlet tiny = read_csv("tiny.csv")\nnrow(tiny)');
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await expect(registryDetail.getByText("Installed", { exact: true })).toBeVisible();
  await expect(registryDetail.getByText("Open", { exact: true })).toBeVisible();
  await expect(registryDetail.getByText("Locally modified", { exact: true })).toBeVisible();
  await registryDetail.getByText("Share…", { exact: true }).click();
  await expect(registryDetail.getByRole("button", { name: "Copy catalogue link" })).toBeVisible();
  await expect(registryDetail.getByRole("button", { name: "Copy Studio link" })).toBeVisible();
  await expect(registryDetail.getByRole("button", { name: "Copy checksum link" })).toBeVisible();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: "Prepare", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible();
  await page.locator("article.cell-code").getByRole("button", { name: /Run cell/ }).click();
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
  await expect(page.getByText(/failed its shared or registry SHA-256 check/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Install Tampered lesson" })).toBeVisible();
});

test("offers and verifies an explicit update when an installed lesson checksum changes", async ({ page }) => {
  const manifestUrl = "https://registry-lesson.example.test/update.json";
  let manifest = {
    schema: 1, id: "update-demo", title: "Update demo", summary: "First revision.", entry: "update.bln",
    runtime: "browser", estimatedMemoryMb: 1,
    source: { title: "Test fixture", url: "https://registry-lesson.example.test/source", note: "Synthetic" },
    datasets: [], tags: ["test"]
  };
  const registryEntry = () => ({
    schema: 1, kind: "lesson", id: "test/update-demo", name: "update-demo", title: "Update demo",
    summary: manifest.summary, publisher: "test", version: "0.1.0", status: "preview", verified: false,
    manifest: manifestUrl, manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    publishedAt: "2026-08-30", compatibility: { runtimes: ["browser"] }, categories: ["teaching"], tags: ["test"],
    sourceRepository: "https://github.com/example/update-demo", licence: "MIT", validation: "fixture"
  });
  await page.unroute(REGISTRY);
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [registryEntry()] } }));
  await page.route(manifestUrl, route => route.fulfill({ contentType: "application/json", body: JSON.stringify(manifest) }));
  await page.route("https://registry-lesson.example.test/update.bln", route => route.fulfill({ contentType: "text/plain", body: "# Update demo\n\n```biolang\n1 + 1\n```\n" }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await page.getByRole("button", { name: "Install Update demo" }).click();
  await expect(page.getByText(/checksum-verified and installed/)).toBeVisible();

  manifest = { ...manifest, summary: "Second revision." };
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await page.getByRole("button", { name: "Refresh registry" }).click();
  await expect(page.getByText("Update available").first()).toBeVisible();
  await page.getByRole("button", { name: "Update Update demo" }).click();
  await expect(page.getByRole("dialog", { name: "Update Update demo" })).toBeVisible();
  await expect(page.getByText("Your work is kept")).toBeVisible();
  await page.getByRole("button", { name: "Update lesson" }).click();
  await expect(page.getByText(/new registry checksum was verified/)).toBeVisible();
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Update demo", exact: true })).toBeVisible();
  await expect(page.getByText("Update available")).toHaveCount(0);
});

test("reviews an exact lesson link before explicitly installing, preparing, and running all", async ({ page }) => {
  const manifest = {
    schema: 1, id: "shared-run", title: "Shared run lesson", summary: "A safe one-click lesson fixture.",
    entry: "shared-run.bln", runtime: "browser", estimatedMemoryMb: 2,
    source: { title: "Test fixture", url: "https://shared-lesson.example.test/source", note: "Synthetic" },
    datasets: [{
      id: "tiny", title: "Tiny CSV", path: "tiny.csv", url: "https://shared-lesson.example.test/tiny.csv",
      bytes: 12, sha256: "2a2b86e74ffd5e6a9b75e52a105cf9d02920837179f8e8961aa15411d380f7a3",
      mediaType: "text/csv", source: "Synthetic fixture", citation: "None", rights: "Test data"
    }], tags: ["test"]
  };
  const manifestText = JSON.stringify(manifest);
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  await page.unroute(REGISTRY);
  await page.route(REGISTRY, route => route.fulfill({ json: { schema: 1, entries: [{
    schema: 1, kind: "lesson", id: "test/shared-run", name: "shared-run", title: "Shared run lesson",
    summary: manifest.summary, publisher: "test", version: "0.1.0", status: "stable", verified: true,
    manifest: "https://shared-lesson.example.test/lesson.json", manifestSha256, publishedAt: "2026-08-30",
    compatibility: { runtimes: ["browser"] }, categories: ["teaching"], tags: ["test"],
    sourceRepository: "https://github.com/example/shared-run", licence: "MIT", validation: "fixture"
  }] } }));
  await page.route("https://shared-lesson.example.test/lesson.json", route => route.fulfill({ contentType: "application/json", body: manifestText }));
  await page.route("https://shared-lesson.example.test/shared-run.bln", route => route.fulfill({ contentType: "text/plain", body: "# Shared run\n\n```biolang\nlet tiny = read_csv(\"tiny.csv\")\nnrow(tiny)\n```\n" }));
  await page.route("https://shared-lesson.example.test/tiny.csv", route => route.fulfill({ contentType: "text/csv", body: "x,y\n1,2\n3,4\n" }));

  await page.goto("/?lesson=test%2Fshared-run%400.1.0");
  const review = page.getByRole("dialog", { name: "Review shared lesson" });
  await expect(review.getByRole("heading", { name: "Shared run lesson" })).toBeVisible();
  await expect(review.getByText("Registry checksum pinned · publisher verified")).toBeVisible();
  await expect(page.locator('input[aria-label="Notebook name"]')).not.toHaveValue("shared-run.bln");
  await review.getByRole("button", { name: "Install, prepare & run all" }).click();

  await expect(page).not.toHaveURL(/lesson=/);
  await expect(page.locator('input[aria-label="Notebook name"]')).toHaveValue("shared-run.bln");
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("article.cell-code .result")).toContainText("2", { timeout: 30_000 });

  await page.goto("/?lesson=test%2Fshared-run%400.1.0");
  const reopenedReview = page.getByRole("dialog", { name: "Review shared lesson" });
  await expect(reopenedReview.getByRole("heading", { name: "Shared run lesson" })).toBeVisible();
  await reopenedReview.getByRole("button", { name: "Install and open" }).click();
  await expect(page).not.toHaveURL(/lesson=/);
  await expect(page.getByRole("tab", { name: "shared-run.bln" })).toHaveCount(1);
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
