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

## Installer and clean machine

- Build the release bundle with `npm run studio:build`.
- To build only the self-contained NSIS setup executable, use
  `npm run studio:build -- --bundles nsis`.
- Install it on Windows without Rust, Node.js, or the source checkout.
- Confirm Browser mode starts and runs a notebook without extra tools.
- Confirm Desktop mode remains an explicit choice and gives a clear message if
  `bl.exe` is not installed or discoverable.
- Install BioLang, repeat Desktop execution, import a local file, export a
  variable, and verify the output checksum.
- Uninstall Studio and confirm user notebooks outside application storage are
  untouched.
