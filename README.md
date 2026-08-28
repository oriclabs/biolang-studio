# BioLang Studio

Live application: <https://oriclabs.com/biolang-studio/>

BioLang Studio is a focused notebook application for learning and reproducible analysis. It runs ordinary BioLang in a browser Worker, can use a native desktop bridge for large local files, and can submit advanced work to the existing SOMER v1 API.

It is deliberately separate from `bl.exe`: the CLI stays small and scriptable, while Studio can evolve its editor, offline storage, lesson catalogue, and visual result panes independently.

## Current capabilities

- live `.bln` editing with markdown and BioLang cells;
- persistent browser interpreter with automatic prerequisite execution;
- BioLang WASM off the UI thread;
- tables, text, and sandboxed SVG plots as typed outputs;
- local file attachment and verified, on-demand lesson datasets;
- PWA shell and private workspace autosave using OPFS with a local-storage fallback;
- a SOMER remote kernel using the same `/v1` contract as BioLang Desktop;
- an interface for a future native desktop bridge;
- registry-discovered lessons, datasets, and provider metadata, with client-side search and on-demand verified preparation;
- custom lesson packages that users can add and remove without rebuilding Studio.

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

After a public deployment, `npm run test:live` verifies the published registry and manifest checksum, installs the real BDSR lesson, prepares its two source-hosted datasets, runs every cell and BioLang plot in browser WASM, and removes the lesson again. It is intentionally opt-in rather than part of pull-request CI because it depends on external hosts.

## Content policy

Studio ships no subject-specific lessons. It discovers metadata from the separate `biolang-registry`, or accepts a custom HTTPS manifest URL, and can remove a lesson together with its cached declared datasets. Discovery does not install a lesson or download data. Registry installation verifies the exact manifest bytes against the registry SHA-256 before parsing them. The content repository—not Studio—owns that lesson's examples, reference results, citations, and validation tests.

Lesson and registered-dataset manifests declare source URL, exact bytes, SHA-256, citation, and rights note. Studio downloads only after the user chooses Prepare, verifies the response, caches it locally, and attaches supported text data to the active kernel. Provider entries describe reviewed built-in adapters; the registry cannot supply executable downloader code or credentials. Large and binary data belongs in `bl data fetch`, native Desktop/SOMER, or a range-aware format; it is not checked into this repository or silently loaded by a lesson.
