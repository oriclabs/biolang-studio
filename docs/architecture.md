# Architecture

Studio is content-neutral. One notebook UI talks to a small `Kernel` interface:

```text
notebook cells ── Kernel ── browser: Web Worker + BioLang WASM
                        ├── desktop: native bridge + local BioLang
                        └── remote: SOMER v1 + worker/cluster BioLang
```

## Browser kernel

The WASM interpreter lives in a dedicated Worker, so parsing, statistics, and plots do not freeze editing. Interpreter state persists between cell calls. Running a later cell automatically evaluates unexecuted prerequisites. Cancelling terminates and recreates the Worker, which is the only reliable hard cancellation boundary for synchronous WASM.

Files are fetched asynchronously before execution, verified, then attached to an in-memory virtual file map. The synchronous WASM file bridge reads only that map; BioLang code cannot make an undeclared network request through it.

## Data tiers

1. Tiny examples live in notebook source.
2. Teaching data is declared by manifest and downloaded to the browser cache only after the user chooses **Prepare**.
3. User files are attached through the browser file picker and remain local to that kernel.
4. Large, indexed, or native-tool work uses Desktop or SOMER. The browser warns at 50 MB rather than pretending RAM is a filesystem.

Workspace text autosaves to Origin Private File System where available. Export to `.bln` is the portable, user-controlled backup.

## Installable lessons

Studio's built-in catalogue is empty. The separate registry supplies discovery metadata and a checksum for the exact lesson manifest; it does not contain course files. The browser stores metadata only for lessons the user explicitly installs. A content repository owns its notebooks, datasets, validation artefacts, and subject-specific tests. Removing a lesson removes its local catalogue entry and cached declared data, even when the source server is offline.

This keeps BDSR, HBC, Rosalind, or any future course out of the Studio application itself. They all use the same versioned manifest contract.

## Trust boundaries

- Rendered markdown does not enable raw HTML.
- SVG output is put in a sandboxed iframe, not inserted into the application DOM.
- Remote SOMER bearer tokens live only in React/process memory.
- Dataset manifests require HTTPS, exact size, and SHA-256.
- Registry lessons require an HTTPS manifest whose exact bytes match the registry SHA-256 before JSON parsing.
- PWA caching covers the application shell and user-prepared content, not arbitrary remote data.

## Desktop boundary

The web application detects `window.__BIOLANG_DESKTOP__`. A Tauri or WebView host can implement the named kernel commands without forking the notebook UI. The repo does not yet package another copy of `bl.exe`; the bridge can bind the native runtime or discover an installed CLI when the desktop phase is undertaken.
