# BioLang Studio

Live application: <https://oriclabs.com/biolang-studio/>

BioLang Studio is a focused notebook application for learning and reproducible analysis. It runs ordinary BioLang in a browser Worker, can use a native desktop bridge for large local files, and can submit advanced work to the existing SOMER v1 API.

It is deliberately separate from `bl.exe`: the CLI stays small and scriptable, while Studio can evolve its editor, offline storage, lesson catalogue, and visual result panes independently.

## Current capabilities

- live `.bln` editing with markdown and BioLang cells, plus optional collapsible lesson steps;
- multiple notebook tabs with isolated variables, one active kernel, close/reopen, and local session restoration;
- persistent browser interpreter with automatic prerequisite execution;
- BioLang WASM off the UI thread;
- tables, text, and sandboxed SVG plots as typed outputs;
- notebook-only or workspace-shared local attachments and verified, on-demand datasets cached once by checksum;
- consent-driven HTTPS text imports with optional expected size/checksum, a hard browser limit, cached bytes, and portable URL provenance;
- PWA shell and private workspace autosave using OPFS with a local-storage fallback;
- a SOMER remote kernel using the same `/v1` contract as BioLang Desktop;
- an opt-in native Desktop bridge with per-notebook private directories, native file selection, checksum-verified HTTPS streaming, and direct-to-disk variable export;
- native `.bln` and `.blw` Open, Save and Save As dialogs with same-directory atomic replacement, recent-file shortcuts, external-change detection, and overwrite protection;
- a full registry workspace with shareable searches, content/runtime/category/access/trust filters, provenance and file details, and runtime-aware actions;
- registry-discovered lessons, datasets, and provider metadata, with client-side search and on-demand verified preparation;
- custom lesson packages that users can add and remove without rebuilding Studio.
- portable `.blw` workspace import/export containing notebook text and data references, never embedded raw data or interpreter variables.
- recoverable, checksum-wrapped session autosaves with verified temporary and backup copies;
- local storage usage, quota warnings, persistence requests, and cache clearing that preserves notebooks and data references;
- bounded, exact browser export from the Variables menu, with native `:export name file.ext` guidance for values that should stream directly to disk;
- published intermediate outputs with checksums and producer/run provenance, scoped to one notebook or explicitly shared across a workspace;
- an exportable run record with notebook and executed-source hashes, exact input fingerprints, backend disclosure, timing, and native BioLang/platform details when available;

Neither the 8.9 MB browser runtime nor remote lesson datasets are committed. `npm run sync:runtime` copies the WASM build from a sibling BioLang checkout before a production build.

## Develop

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The default runtime source is `../biolang/desktop/public/wasm`; set `BIOLANG_SOURCE` to another BioLang checkout when needed.

```powershell
npm test
npm run check:content
npm run build
npm run test:e2e
```

To run Studio inside the native BioLang Desktop shell, use the wrapper scripts from `../biolang/desktop`:

```powershell
npm run studio:dev
npm run studio:build -- --debug --no-bundle
```

Native execution is never selected automatically. The user must choose **Desktop** and confirm native access. Each notebook receives a private application-cache directory; selected local files are copied there atomically, public HTTPS data streams there without browser CORS, and exports stream to a user-selected destination. Browser Studio remains the default, while SOMER is the explicit handoff for protected or remote compute.

When Studio is running in the Desktop shell, notebook and workspace paths remain device-local and are never written into a portable `.blw`. The toolbar uses native Open/Save dialogs, keeps the eight most recent Desktop files locally, and remembers the SHA-256 observed at open or save time. Returning focus to Studio checks bound files for outside changes. A changed or deleted file can be reloaded; saving over it always requires explicit confirmation. Writes use a temporary file in the destination directory and an atomic rename, so an interrupted save does not erase the previous complete file.

After a public deployment, `npm run test:live` verifies the published registry and manifest checksum, installs the real BDSR lesson, prepares its two source-hosted datasets, runs every cell and BioLang plot in browser WASM, and removes the lesson again. It is intentionally opt-in rather than part of pull-request CI because it depends on external hosts.

## Content policy

Studio ships no subject-specific lessons. It discovers metadata from the separate `biolang-registry`, or accepts a custom HTTPS manifest URL, and can remove a lesson together with its cached declared datasets. Discovery does not install a lesson or download data. Registry installation verifies the exact manifest bytes against the registry SHA-256 before parsing them. The content repository—not Studio—owns that lesson's examples, reference results, citations, and validation tests.

The public catalogue reads `https://registry.lang.bio/v1/index.json`, falls back to the GitHub-hosted index when the custom domain is unavailable, and then falls back to its last validated browser cache. Catalogue filters and the selected entry are encoded in the page URL so a search can be shared without installing anything.

Lessons remain ordinary `.bln` documents rather than a Studio-only format. Markdown is parsed into explanation cells and fenced `biolang` blocks are parsed into runnable code cells automatically. Code-block directives such as `# @skip` and `# @hide-output` travel with the notebook.

Authors can keep a question, its code, and its interpretation together with optional HTML-comment markers. The comments remain harmless in any Markdown reader, while Studio adds **Run step**, collapse, and source-editing controls:

````markdown
<!-- bl:step title="Why does the mean move?" -->

Explain the question in plain language.

```biolang
mean(values)
```

Explain the result.

<!-- /bl:step -->
````

When writing an explanation cell, only explicit fenced `biolang` or `bl` blocks become executable; inline backticks remain prose. The Variables inspector is collapsed by default and shows its current item count, leaving the sidebar focused on lessons and data.

The Variables menu exports the selected value rather than its shortened inspector preview. Browser exports are capped before an extra byte is written beyond the 10 MB result limit; larger values should use `:export variable result.json` (or `.csv`, `.tsv`, or `.txt`) in native BioLang, which serializes incrementally to an atomic temporary file. Sparse matrices default to JSON so an export does not accidentally densify them.

Each notebook tab has its own cells, lesson, results, variables, and execution boundary. Studio keeps one active kernel: switching tabs starts a clean interpreter and the next run replays that notebook's required earlier cells. This deliberately prevents invisible variable sharing and avoids retaining several WASM runtimes in memory.

Native kernel commands carry the notebook identity on every request. A late completion or disposal from a previous tab therefore cannot evaluate in, attach data to, or stop the newly active tab. Cancelling native execution terminates and recreates that notebook interpreter; Studio invalidates its execution boundary so the next run replays required cells rather than trusting variables that no longer exist.

The Data panel is workspace-aware. A local file starts as **this notebook** and can be promoted with **Share**; registry datasets prepared from the registry are workspace-shared. File bytes are cached once by SHA-256 and remounted when another tab needs them. Detaching a file does not silently delete its verified cache.

**Export workspace** writes a `.blw` JSON document with notebook source, lesson metadata, attachment scope, dataset URLs, sizes, hashes, citations, and local-file fingerprints. It does not contain raw attached data, credentials, results, or interpreter variables. On another machine, registry data can be prepared again from its declared source; local files are clearly marked for reattachment and must match their recorded checksum.

**Export latest run record** writes a separate `.run.json` provenance artifact after any attempted run. It identifies success or failure, the exact notebook and executed-code hashes, input paths/sizes/SHA-256 values, runtime backend, wall timing, and native version/platform information when the backend exposes it. It deliberately does not store credentials, data bytes, or interpreter values. Its schema is published at [`public/schemas/biolang-studio-run-v1.schema.json`](public/schemas/biolang-studio-run-v1.schema.json).

The current contract is published at [`public/schemas/biolang-workspace-v3.schema.json`](public/schemas/biolang-workspace-v3.schema.json); v1 and v2 remain published and migrate to v3 on open. Studio rejects newer schemas with an update message and rejects unknown older schemas rather than guessing a migration. Effective mount paths are checked across shared and notebook-only data, so two different files cannot silently appear under the same BioLang path.

From a variable's action menu, **Publish output** serializes the complete value to a safe relative path such as `outputs/qc.csv`. Browser mode caps publication before memory becomes unsafe; Desktop streams it into the notebook's private disk area. The resulting workspace reference records its size, SHA-256, variable, format, producer notebook, time, and executed-source hash when available. Sharing is explicit. Another notebook receives the file through the same checksum-verified mounting path as an input, without receiving or depending on the producer's interpreter state.

Session autosaves are device-local and write a checksum-wrapped temporary copy, primary copy, and previous-good backup through a serialized queue. Startup validates each candidate and recovers only a complete workspace. The Local storage disclosure reports browser usage and quota, can request protection from automatic eviction, and can clear cached file bytes without deleting notebook text or provenance references.

Lesson and registered-dataset manifests declare source URL, exact bytes, SHA-256, citation, and rights note. Studio downloads only after the user chooses Prepare, verifies the response, caches it locally, and attaches supported text data to the active kernel. Provider entries describe reviewed built-in adapters; the registry cannot supply executable downloader code or credentials. Large and binary data belongs in `bl data fetch`, native Desktop/SOMER, or a range-aware format; it is not checked into this repository or silently loaded by a lesson.

For an independent public file, **Data → From URL** presents the HTTPS source, mount path, expected type, expected size, checksum and notebook scope for review before downloading. Published SHA-256 and byte counts can be supplied; otherwise Studio pins the observed source hash and byte count in workspace provenance after the first successful fetch. Fetches omit credentials and referrers, require browser CORS, accept valid UTF-8 text only, and stop while streaming at 50 MB. Authenticated, binary, or larger data remains a Desktop/SOMER workflow.
