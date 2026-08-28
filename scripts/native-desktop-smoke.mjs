import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const endpoint = process.env.BIOLANG_STUDIO_CDP ?? "http://127.0.0.1:9223";
const temporaryRoot = await mkdtemp(join(tmpdir(), "biolang-studio-native-smoke-"));
const fixture = process.env.BIOLANG_STUDIO_SMOKE_NOTEBOOK ?? join(temporaryRoot, "native-smoke.bln");
const saved = process.env.BIOLANG_STUDIO_SMOKE_SAVED ?? join(temporaryRoot, "native-smoke-saved.bln");
const realTenx = process.env.BIOLANG_STUDIO_REAL_10X;
if (!process.env.BIOLANG_STUDIO_SMOKE_NOTEBOOK) {
  await writeFile(fixture, "# Native smoke test\n\n```biolang\nlet smoke_value = 41\nsmoke_value + 1\n```\n", "utf8");
}

let browser;
try {
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap(context => context.pages())
    .find(candidate => candidate.url().startsWith("http://tauri.localhost"));
  assert(page, "BioLang Desktop WebView was not found at the CDP endpoint");
  await page.waitForLoadState("domcontentloaded");

  const bridgeReady = await page.evaluate(() => Boolean(
    window.__BIOLANG_DESKTOP__?.invoke ?? window.__TAURI_INTERNALS__?.invoke,
  ));
  assert.equal(bridgeReady, true, "the real Tauri command bridge is unavailable");

  const invoke = (command, payload) => page.evaluate(
    async ({ command, payload }) => {
      const nativeInvoke = window.__BIOLANG_DESKTOP__?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
      if (!nativeInvoke) throw new Error("the real Tauri command bridge is unavailable");
      return nativeInvoke(command, payload);
    },
    { command, payload },
  );

  const original = await readFile(fixture, "utf8");
  const opened = await invoke("studio_open_document", { kind: "notebook", path: fixture });
  assert.equal(opened.contents, original);
  assert.equal(opened.filename, "native-smoke.bln");
  assert.match(opened.sha256, /^[a-f0-9]{64}$/);

  const firstSave = await invoke("studio_save_document", {
    request: {
      kind: "notebook",
      path: saved,
      suggestedName: "native-smoke-saved.bln",
      contents: original,
      overwrite: true,
    },
  });
  assert.equal(firstSave.status, "saved");
  assert.equal(await readFile(saved, "utf8"), original);

  const externalContents = `${original}\n<!-- external edit -->\n`;
  await writeFile(saved, externalContents, "utf8");
  const externalStatus = await invoke("studio_document_status", {
    path: saved,
    expectedSha256: firstSave.document.sha256,
  });
  assert.equal(externalStatus.exists, true);
  assert.equal(externalStatus.changed, true);

  const conflict = await invoke("studio_save_document", {
    request: {
      kind: "notebook",
      path: saved,
      suggestedName: "native-smoke-saved.bln",
      contents: original,
      expectedSha256: firstSave.document.sha256,
      overwrite: false,
    },
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(await readFile(saved, "utf8"), externalContents);

  const overwritten = await invoke("studio_save_document", {
    request: {
      kind: "notebook",
      path: saved,
      suggestedName: "native-smoke-saved.bln",
      contents: original,
      expectedSha256: firstSave.document.sha256,
      overwrite: true,
    },
  });
  assert.equal(overwritten.status, "saved");
  assert.equal(await readFile(saved, "utf8"), original);

  const namespaceA = `native-smoke-a-${Date.now()}`;
  const namespaceB = `native-smoke-b-${Date.now()}`;
  await invoke("kernel_initialize", { namespace: namespaceA });
  await invoke("kernel_initialize", { namespace: namespaceB });
  await invoke("kernel_dispose", { namespace: namespaceA });
  const isolated = await invoke("kernel_execute", {
    namespace: namespaceB,
    source: "let tab_b_value = 40\ntab_b_value + 2",
  });
  assert.equal(isolated.status, "ok");
  assert.match(`${isolated.output}\n${isolated.value?.text ?? ""}`, /42/);

  const slow = invoke("kernel_execute", { namespace: namespaceB, source: "sleep(30000)" })
    .then(value => ({ resolved: true, value }), error => ({ resolved: false, error: String(error) }));
  await new Promise(resolve => setTimeout(resolve, 250));
  const cancelStarted = performance.now();
  await invoke("kernel_cancel", { namespace: namespaceB });
  const cancelled = await slow;
  const cancelElapsedMs = performance.now() - cancelStarted;
  assert.equal(cancelled.resolved, false, "long native execution unexpectedly completed after cancellation");
  assert(cancelElapsedMs < 5_000, `native cancellation took ${cancelElapsedMs.toFixed(0)} ms`);

  const replayed = await invoke("kernel_execute", {
    namespace: namespaceB,
    source: "let replayed_value = 6 * 7\nreplayed_value",
  });
  assert.equal(replayed.status, "ok");
  assert.match(`${replayed.output}\n${replayed.value?.text ?? ""}`, /42/);
  const published = await invoke("kernel_publish_variable", {
    namespace: namespaceB,
    name: "replayed_value",
    format: "json",
    path: "outputs/replayed.json",
  });
  assert.equal(published.path, "outputs/replayed.json");
  assert.match(published.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await invoke("kernel_has_attachment", {
    namespace: namespaceB,
    path: published.path,
    sha256: published.sha256,
  }), true);
  await invoke("kernel_execute", { namespace: namespaceB, source: "let different_value = 43" });
  const conflictingOutput = await invoke("kernel_publish_variable", {
    namespace: namespaceB,
    name: "different_value",
    format: "json",
    path: "outputs/replayed.json",
  }).then(() => false, () => true);
  assert.equal(conflictingOutput, true, "a different value replaced an immutable published output");

  let realData;
  if (realTenx) {
    const portablePath = realTenx.replaceAll("\\", "/");
    const realStarted = performance.now();
    const realResult = await invoke("kernel_execute", {
      namespace: namespaceB,
      source: [
        `let release_pbmc = read_10x_sparse(${JSON.stringify(portablePath)})`,
        "let release_qc = cell_qc(release_pbmc.matrix, release_pbmc.genes)",
        "[release_pbmc.n_cells, release_pbmc.n_genes, len(release_qc)]",
      ].join("\n"),
    });
    assert.equal(realResult.status, "ok");
    const displayed = `${realResult.output}\n${realResult.value?.text ?? ""}`;
    assert.match(displayed, /2700/);
    assert.match(displayed, /32738/);
    realData = {
      path: portablePath,
      cells: 2700,
      genes: 32738,
      kernelDurationMs: realResult.durationMs,
      wallDurationMs: Math.round(performance.now() - realStarted),
    };
  }
  await invoke("kernel_clear_files", { namespace: namespaceB });
  await invoke("kernel_dispose", { namespace: namespaceB });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    page: page.url(),
    documentBytes: opened.size,
    externalChangeDetected: externalStatus.changed,
    conflictProtectedExternalEdit: conflict.status === "conflict",
    staleTabDisposePreservedActiveKernel: isolated.status === "ok",
    cancellationElapsedMs: Math.round(cancelElapsedMs),
    replayAfterCancel: replayed.status === "ok",
    publishedOutput: { path: published.path, bytes: published.size, sha256: published.sha256 },
    conflictingOutputRejected: conflictingOutput,
    realData,
  }, null, 2)}\n`);
} finally {
  await browser?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
