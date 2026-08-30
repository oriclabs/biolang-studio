# Studio release checklist

Run this checklist before publishing a Desktop build. Automated checks are
repeatable; native file-picker interaction and clean-machine installation stay
explicit because CI cannot make a trustworthy choice in an operating-system
dialog.

## Automated acceptance

From `biolang-studio`:

```powershell
npm test
npm run check:content
npm run build
npm run test:e2e
```

For the public web release, confirm the Pages deployment environment reports
`https://studio.lang.bio`, `dist/CNAME` contains exactly `studio.lang.bio`, and
the repository Pages settings show the custom domain with HTTPS enforcement.
After deployment, run `npm run test:live`; the default smoke target is the
custom domain.

Build and launch the debug Desktop wrapper from `../biolang/desktop`, exposing
its WebView debugging endpoint only for this local smoke test:

```powershell
npm run studio:build -- --debug --no-bundle
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
./src-tauri/target/debug/biolang-desktop.exe
```

In another terminal, validate real Desktop IPC. Set the optional 10x path to
exercise the native kernel against PBMC3K rather than only the small fixture:

```powershell
$env:BIOLANG_STUDIO_REAL_10X = "C:/path/to/pbmc3k/filtered_gene_bc_matrices/hg19"
npm run test:native
```

The smoke test must report successful external-change detection, conflict
protection, stale-tab isolation, cancellation, replay after cancellation, and
the expected PBMC3K dimensions of 2,700 cells by 32,738 genes.

From `../biolang/desktop`, run the opt-in 1 GiB streaming test:

```powershell
npm run test:studio-stress
```

## Native file dialogs

- Open an existing `.bln`, edit it, save it, close it, and reopen it.
- Use **Save As** for both `.bln` and `.blw`; cancel once and confirm nothing is
  written.
- Change an open file in another editor. Return to Studio, reload it, then
  repeat and verify that Save asks before overwriting the outside change.
- Confirm the recent-files menu opens the saved files and forgets a missing
  file cleanly.

## Notebook reports

- Run a notebook containing prose, a table and an SVG plot, then export
  self-contained HTML. Open it offline and confirm no raw dataset or credential
  bytes are embedded.
- Export the Markdown ZIP and confirm `report.md`, SVG figures, `run.json` and
  `manifest.json` open independently.
- Open the print-ready view, use **Save as PDF**, and inspect every page for
  clipped code, split tables or plots, and missing provenance.
- Confirm an unrun, stale or failed cell is disclosed before export and in the
  resulting report.
- Confirm `|>` remains two literal characters in code and report output, and
  HTTP(S) links open in a new tab.
- Download the standalone `.bln` and `.bl`; confirm the notebook remains
  editable and the script contains runnable code cells in order but no
  explicit `# @skip` cell.
- Export the CLI project ZIP. Confirm it contains the notebook, script,
  `lesson-data.json`, `README.md`, and `PROVENANCE.md`, but no dataset bytes.
- With a current `bl`, run `bl lesson prepare lesson-data.json`, then
  `bl lesson run lesson-data.json --offline`. Confirm declared paths remain
  inside the unpacked directory and every input is verified by size and hash.

## Installer and clean machine

- Build the release bundle with `npm run studio:build`.
- To build only the self-contained NSIS setup executable, use
  `npm run studio:build -- --bundles nsis`.
- Install it on Windows without Rust, Node.js, or the source checkout.
- Confirm Browser mode starts and runs a notebook without extra tools.
- Confirm Desktop mode remains an explicit choice and gives a clear message if
  `bl.exe` is not installed or discoverable.
- Confirm Desktop mode rejects an older `bl.exe` that lacks the
  `export-variable` console capability, with an upgrade or `BIOLANG_BIN` hint.
- Install BioLang, repeat Desktop execution, import a local file, export a
  variable, and verify the output checksum.
- Uninstall Studio and confirm user notebooks outside application storage are
  untouched.
