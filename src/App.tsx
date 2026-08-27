import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CatalogEntry, LessonManifest } from "./content/manifest";
import { validateManifest } from "./content/manifest";
import { installLesson, installedLessons, uninstallLesson } from "./content/installed";
import { DEFAULT_REGISTRY_URL, fetchRegistry, type RegistryEntry, type RegistrySource } from "./content/registry";
import type { AttachedFile, ExecutionResult, Kernel, KernelKind, StructuredResult } from "./kernel/protocol";
import { DesktopKernel, desktopAvailable } from "./kernel/desktop-client";
import { SomerKernel } from "./kernel/somer-client";
import { WasmKernel } from "./kernel/wasm-client";
import { directives, executableSource, parseNotebook, serializeNotebook, type NotebookCell } from "./notebook/format";
import { hasDataset, prepareDataset, removeDataset, saveWorkspace, sha256 } from "./storage/content-store";

type Cell = NotebookCell & { result?: ExecutionResult; editing?: boolean };
type Notice = { tone: "info" | "good" | "bad"; text: string } | null;

const SAMPLE = `# Start here

Edit a cell, run it, and inspect the result. Variables stay available to later cells.

\`\`\`biolang
let measurements = [12, 14, 15, 15, 16, 19, 28]
summary(measurements)
\`\`\`

The mean moves toward 28 more than the median does. That is why the data story matters before choosing a centre.

\`\`\`biolang
{mean: mean(measurements), median: median(measurements)}
\`\`\`
`;

function displayBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function ResultView({ result }: { result?: ExecutionResult }) {
  if (!result) return null;
  return <div className={`result ${result.ok ? "result-ok" : "result-error"}`}>
    <div className="result-meta"><span>{result.backend ?? "kernel"}</span><span>{result.elapsedMs ?? 0} ms</span></div>
    {result.output && <pre className="stdout">{result.output}</pre>}
    {!result.ok && <pre className="error-text">{result.error}</pre>}
    {result.ok && result.results?.map((item, index) => <StructuredView key={index} result={item} />)}
    {result.ok && !result.results?.length && result.value && result.value !== "Nil" && <pre>{result.value}</pre>}
  </div>;
}

function StructuredView({ result }: { result: StructuredResult }) {
  const markup = typeof result.data === "string" ? result.data : typeof result.value === "string" ? result.value : "";
  if ((result.kind === "plot" || result.format === "svg") && markup.includes("<svg")) {
    return <iframe title="BioLang plot" className="plot-frame" sandbox="" srcDoc={`<!doctype html><style>body{margin:0;background:white}svg{display:block;width:100%;height:auto}</style>${markup}`} />;
  }
  if (result.columns && result.rows) return <div className="table-wrap"><table><thead><tr>{result.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{result.rows.slice(0, 100).map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{String(value ?? "")}</td>)}</tr>)}</tbody></table>{result.truncated && <p>Showing a preview of {result.totalRows ?? "many"} rows.</p>}</div>;
  return <pre>{JSON.stringify(result.value ?? result, null, 2)}</pre>;
}

export default function App() {
  const kernelRef = useRef<Kernel | null>(null);
  const attachedRef = useRef(new Map<string, AttachedFile>());
  const needsResetRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const notebookInput = useRef<HTMLInputElement>(null);
  const [cells, setCells] = useState<Cell[]>(() => parseNotebook(SAMPLE));
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [lesson, setLesson] = useState<LessonManifest | null>(null);
  const [filename, setFilename] = useState("untitled.bln");
  const [kernelKind, setKernelKind] = useState<KernelKind>(desktopAvailable() ? "desktop" : "browser");
  const [kernelState, setKernelState] = useState("starting");
  const [validThrough, setValidThrough] = useState(-1);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice>({ tone: "info", text: "Run any code cell; required earlier cells run automatically." });
  const [variables, setVariables] = useState<unknown[]>([]);
  const [dataReady, setDataReady] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [packageOpen, setPackageOpen] = useState(false);
  const [packageUrl, setPackageUrl] = useState("");
  const [registryEntries, setRegistryEntries] = useState<RegistryEntry[]>([]);
  const [registrySource, setRegistrySource] = useState<RegistrySource | "loading" | "unavailable">("loading");
  const [registryError, setRegistryError] = useState("");
  const [installingId, setInstallingId] = useState("");

  useEffect(() => {
    fetch("./catalog/index.json").then(response => response.json()).then((builtIn: CatalogEntry[]) => {
      const installed = installedLessons();
      setCatalog([...builtIn, ...installed.filter(item => !builtIn.some(base => base.id === item.id))]);
    }).catch(() => setCatalog(installedLessons()));
  }, []);

  useEffect(() => { void refreshRegistry(); }, []);

  useEffect(() => {
    let alive = true;
    const kernel: Kernel = kernelKind === "desktop" ? new DesktopKernel() : kernelKind === "somer" ? new SomerKernel(remoteUrl, remoteToken) : new WasmKernel();
    kernelRef.current?.dispose(); kernelRef.current = kernel; setKernelState("starting"); setVariables([]); setValidThrough(-1);
    kernel.initialize().then(async () => {
      for (const file of attachedRef.current.values()) await kernel.attach(file);
      if (alive) setKernelState("ready");
    }).catch(error => alive && (setKernelState("failed"), setNotice({ tone: "bad", text: error.message })));
    return () => { alive = false; kernel.dispose(); };
  }, [kernelKind, remoteUrl, remoteToken]);

  useEffect(() => {
    const timer = setTimeout(() => void saveWorkspace(filename, serializeNotebook(cells)), 800);
    return () => clearTimeout(timer);
  }, [cells, filename]);

  const codeCount = useMemo(() => cells.filter(cell => cell.type === "code").length, [cells]);
  const discoverable = useMemo(() => registryEntries.filter(entry => entry.kind === "lesson" && entry.status !== "withdrawn" && !catalog.some(item => item.id === entry.name)), [registryEntries, catalog]);

  function updateCell(index: number, patch: Partial<Cell>) {
    setCells(current => current.map((cell, position) => position === index ? { ...cell, ...patch } : cell));
    if (patch.source !== undefined) { needsResetRef.current = true; setValidThrough(current => Math.min(current, index - 1)); }
  }

  async function refreshVariables() {
    try { setVariables(await kernelRef.current!.listVariables()); } catch { setVariables([]); }
  }

  async function runTo(end: number, restart = false) {
    if (!kernelRef.current || running || kernelState !== "ready") return;
    setRunning(true); setNotice(null);
    let start = Math.max(0, validThrough + 1);
    try {
      if (restart || needsResetRef.current || end <= validThrough || kernelKind === "somer") { await kernelRef.current.reset(); needsResetRef.current = false; start = 0; setValidThrough(-1); }
      if (kernelKind === "somer") {
        const runnable = cells.slice(0, end + 1).filter(cell => cell.type === "code" && !directives(cell.source).skip).map(cell => executableSource(cell.source)).filter(Boolean);
        const result = await kernelRef.current.execute(runnable.join("\n\n"));
        updateCell(end, { status: result.ok ? "done" : "error", result });
        if (!result.ok) { setNotice({ tone: "bad", text: result.error ?? "Remote execution failed." }); return; }
        setValidThrough(end); setNotice({ tone: "good", text: `SOMER ran ${runnable.length} code cells as one reproducible job.` }); return;
      }
      for (let index = start; index <= end; index++) {
        const cell = cells[index];
        if (!cell || cell.type !== "code") { setValidThrough(index); continue; }
        const instruction = directives(cell.source);
        const source = executableSource(cell.source);
        if (instruction.skip || !source) { updateCell(index, { status: "skipped", result: undefined }); setValidThrough(index); continue; }
        updateCell(index, { status: "running", result: undefined });
        const result = await kernelRef.current.execute(source);
        updateCell(index, { status: result.ok ? "done" : "error", result });
        if (!result.ok) { setValidThrough(index - 1); setNotice({ tone: "bad", text: `Stopped at cell ${index + 1}: ${result.error}` }); return; }
        setValidThrough(index);
      }
      await refreshVariables();
      setNotice({ tone: "good", text: `Finished through cell ${end + 1}. Earlier code cells were run when needed.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
    finally { setRunning(false); }
  }

  async function loadLesson(entry: CatalogEntry, propagateError = false) {
    try {
      const manifestUrl = new URL(entry.manifest, location.href);
      const manifestResponse = await fetch(manifestUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!manifestResponse.ok) throw new Error(`Lesson manifest returned HTTP ${manifestResponse.status}.`);
      const manifestText = await manifestResponse.text();
      if (entry.manifestSha256) {
        const actual = await sha256(manifestText);
        if (actual.toLowerCase() !== entry.manifestSha256.toLowerCase()) throw new Error("The lesson manifest changed and no longer matches its installed registry checksum.");
      }
      const manifest = validateManifest(JSON.parse(manifestText));
      const sourceResponse = await fetch(new URL(manifest.entry, manifestUrl), { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!sourceResponse.ok) throw new Error(`Lesson notebook returned HTTP ${sourceResponse.status}.`);
      const source = await sourceResponse.text();
      setLesson(manifest); setCells(parseNotebook(source)); setFilename(`${manifest.id}.bln`); setValidThrough(-1); setDataReady({});
      await kernelRef.current?.reset(); await kernelRef.current?.clearFiles();
      attachedRef.current.clear(); needsResetRef.current = false;
      const states = Object.fromEntries(await Promise.all(manifest.datasets.map(async dataset => {
        const cached = await hasDataset(dataset);
        if (cached && kernelRef.current) {
          const file = await prepareDataset(dataset);
          attachedRef.current.set(file.path, file); await kernelRef.current.attach(file);
        }
        return [dataset.id, cached];
      })));
      setDataReady(states); setNotice({ tone: "info", text: `Loaded ${manifest.title}. Prepare its declared data before running.` });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
      if (propagateError) throw error;
    }
  }

  async function refreshRegistry() {
    setRegistrySource("loading"); setRegistryError("");
    try {
      const result = await fetchRegistry();
      setRegistryEntries(result.index.entries); setRegistrySource(result.source);
    } catch (error) {
      setRegistryEntries([]); setRegistrySource("unavailable");
      setRegistryError(error instanceof Error ? error.message : String(error));
    }
  }

  async function installFromManifest(rawUrl: string, expectedHash?: string, expectedId?: string) {
    const parsedUrl = new URL(rawUrl, location.href);
    if (parsedUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsedUrl.hostname)) throw new Error("Lesson manifests must use HTTPS (localhost is allowed for development).");
    const manifestUrl = parsedUrl.href;
    const response = await fetch(manifestUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`Lesson manifest returned HTTP ${response.status}.`);
    const manifestText = await response.text();
    if (expectedHash) {
      const actual = await sha256(manifestText);
      if (actual.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("The lesson manifest failed its registry SHA-256 check.");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(manifestText); }
    catch { throw new Error("Lesson manifest is not valid JSON."); }
    const manifest = validateManifest(decoded);
    if (expectedId && manifest.id !== expectedId) throw new Error(`Registry expected lesson '${expectedId}', but the manifest identifies '${manifest.id}'.`);
    const candidate: CatalogEntry = {
      id: manifest.id, title: manifest.title, summary: manifest.summary, manifest: manifestUrl,
      runtime: manifest.runtime, tags: manifest.tags, manifestSha256: expectedHash
    };
    await loadLesson(candidate, true);
    const next = installLesson(manifest, manifestUrl, expectedHash);
    setCatalog(next);
    return manifest;
  }

  async function prepare(id: string) {
    const dataset = lesson?.datasets.find(item => item.id === id);
    if (!dataset || !kernelRef.current) return;
    try {
      if (kernelKind === "browser" && dataset.bytes > 50 * 1024 ** 2) throw new Error(`${dataset.title} is larger than the 50 MB browser guidance limit. Use BioLang Desktop or SOMER for this lesson.`);
      setNotice({ tone: "info", text: `Downloading ${dataset.title} from its declared source…` });
      const file = await prepareDataset(dataset, loaded => setProgress(current => ({ ...current, [id]: loaded })));
      attachedRef.current.set(file.path, file); await kernelRef.current.attach(file); setDataReady(current => ({ ...current, [id]: true }));
      setNotice({ tone: "good", text: `${dataset.title} is verified and ready as ${dataset.path}.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
  }

  async function addPackage() {
    try {
      const manifest = await installFromManifest(packageUrl);
      setPackageOpen(false); setPackageUrl("");
      setNotice({ tone: "good", text: `${manifest.title} was added to this browser. Its data remains unprepared until you request it.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
  }

  async function installRegistryEntry(entry: RegistryEntry) {
    setInstallingId(entry.id);
    try {
      const manifest = await installFromManifest(entry.manifest, entry.manifestSha256, entry.name);
      setNotice({ tone: "good", text: `${manifest.title} was checksum-verified and installed. Its data remains unprepared until you request it.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
    finally { setInstallingId(""); }
  }

  async function removePackage(entry: CatalogEntry) {
    const stored = installedLessons().find(item => item.id === entry.id);
    if (stored?.datasets) await Promise.all(stored.datasets.map(removeDataset));
    const remaining = uninstallLesson(entry.id); setCatalog(remaining);
    if (lesson?.id === entry.id) {
      setLesson(null); setCells(parseNotebook(SAMPLE)); setFilename("untitled.bln"); attachedRef.current.clear(); await kernelRef.current?.reset(); await kernelRef.current?.clearFiles();
    }
    setNotice({ tone: "info", text: `${entry.title} and its cached declared data were removed from this browser.` });
  }

  async function attachFiles(list: FileList | null) {
    if (!list || !kernelRef.current) return;
    for (const file of [...list]) {
      if (kernelKind === "browser" && file.size > 50 * 1024 ** 2) throw new Error("Files over 50 MB are better opened in BioLang Desktop or sent to SOMER.");
      const attached = { path: file.name, contents: await file.text(), size: file.size };
      attachedRef.current.set(attached.path, attached); await kernelRef.current.attach(attached);
    }
    setNotice({ tone: "good", text: `${list.length} local file${list.length === 1 ? "" : "s"} attached to this kernel.` });
  }

  function saveFile() {
    const blob = new Blob([serializeNotebook(cells)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function openFile(file?: File) {
    if (!file) return;
    setCells(parseNotebook(await file.text())); setFilename(file.name); setLesson(null); setValidThrough(-1); attachedRef.current.clear(); needsResetRef.current = false; await kernelRef.current?.reset(); await kernelRef.current?.clearFiles();
  }

  function addCell(type: Cell["type"]) {
    setCells(current => [...current, { id: crypto.randomUUID(), type, source: type === "code" ? "# BioLang code" : "Write what this step answers.", editing: true, status: "" }]);
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><img src="./studio-mark.svg" alt=""/><div><strong>BioLang Studio</strong><small>learn · analyse · reproduce</small></div></div>
      <nav className="toolbar">
        <button onClick={() => notebookInput.current?.click()}>Open</button><button onClick={saveFile}>Save</button>
        <button className="primary" disabled={running} onClick={() => void runTo(cells.length - 1, true)}>▶ Run all</button>
        {running && <button onClick={() => void kernelRef.current?.cancel()}>Stop</button>}
      </nav>
      <div className="kernel-switch">
        <label>Kernel<select value={kernelKind} onChange={event => event.target.value === "somer" ? setRemoteOpen(true) : setKernelKind(event.target.value as KernelKind)}>
          <option value="browser">Browser WASM</option>{desktopAvailable() && <option value="desktop">Desktop</option>}<option value="somer">SOMER remote…</option>
        </select></label><span className={`status status-${kernelState}`}>{kernelState}</span>
      </div>
    </header>
    <aside className="sidebar">
      <section className="discover"><div className="section-head"><h2>Discover</h2><button title="Refresh lesson registry" onClick={() => void refreshRegistry()}>↻</button></div>
        {registrySource === "loading" ? <p className="muted">Checking the lesson registry…</p> : registrySource === "unavailable" ? <div className="registry-message"><p>Registry unavailable.</p><span title={registryError}>You can still open installed lessons or add a manifest URL.</span></div> : <>
          <div className="registry-state"><a href={DEFAULT_REGISTRY_URL} target="_blank" rel="noreferrer">Official registry</a><span>{registrySource === "cache" ? "offline cache" : "live"}</span></div>
          {discoverable.length ? discoverable.map(entry => <div className="registry-entry" key={`${entry.id}@${entry.version}`}>
            <div className="registry-title"><strong>{entry.title}</strong><span className={`trust-badge ${entry.verified ? "verified" : "preview"}`}>{entry.verified ? "Verified" : entry.status}</span></div>
            <p>{entry.summary}</p><div className="registry-meta"><span>{entry.publisher} · v{entry.version} · {entry.licence}</span><button disabled={installingId === entry.id} aria-label={`Install ${entry.title}`} onClick={() => void installRegistryEntry(entry)}>{installingId === entry.id ? "Checking…" : "Install"}</button></div>
          </div>) : <p className="muted">All available lessons are installed.</p>}
        </>}
      </section>
      <section><div className="section-head"><h2>Installed lessons</h2><button title="Add lesson package" onClick={() => setPackageOpen(true)}>＋</button></div>{catalog.length ? catalog.map(item => <div className={`lesson-row ${lesson?.id === item.id ? "active" : ""}`} key={item.id}><button className="lesson-link" onClick={() => void loadLesson(item)}><strong>{item.title}</strong><span>{item.summary}</span></button><button className="remove-package" title={`Remove ${item.title}`} onClick={() => void removePackage(item)}>×</button></div>) : <div className="empty-catalog"><p>No lesson packages installed.</p><button onClick={() => setPackageOpen(true)}>Add from manifest URL</button></div>}</section>
      <section><h2>Data</h2>{lesson ? lesson.datasets.map(dataset => <div className="dataset" key={dataset.id}><div><strong>{dataset.title}</strong><span>{displayBytes(dataset.bytes)} · verified download</span></div><button disabled={dataReady[dataset.id]} onClick={() => void prepare(dataset.id)}>{dataReady[dataset.id] ? "Ready" : progress[dataset.id] ? `${Math.round(progress[dataset.id] / dataset.bytes * 100)}%` : "Prepare"}</button></div>) : <p className="muted">A lesson declares the exact data it needs.</p>}
        <button className="wide" onClick={() => fileInput.current?.click()}>Attach local files</button></section>
      <section><h2>Variables</h2>{variables.length ? <pre className="variables">{JSON.stringify(variables, null, 2)}</pre> : <p className="muted">Run code to inspect values in memory.</p>}</section>
    </aside>
    <main>
      <div className="document-head"><div><input aria-label="Notebook name" value={filename} onChange={event => setFilename(event.target.value)} /><span>{cells.length} cells · {codeCount} runnable</span></div>{lesson && <a href={lesson.source.url} target="_blank" rel="noreferrer">Inspired by {lesson.source.title} ↗</a>}</div>
      {notice && <div className={`notice notice-${notice.tone}`}>{notice.text}</div>}
      <div className="cells">{cells.map((cell, index) => <article className={`cell cell-${cell.type} ${cell.status ?? ""}`} key={cell.id}>
        <div className="cell-rail">{cell.type === "code" ? <button title="Run this cell and any prerequisites" disabled={running} onClick={() => void runTo(index)}>▶</button> : <span>¶</span>}<small>{index + 1}</small></div>
        <div className="cell-body">
          {cell.type === "markdown" && !cell.editing ? <div className="prose" onDoubleClick={() => updateCell(index, { editing: true })}><ReactMarkdown remarkPlugins={[remarkGfm]}>{cell.source}</ReactMarkdown></div> : <textarea aria-label={`${cell.type} cell ${index + 1}`} className={cell.type === "code" ? "code-editor" : "markdown-editor"} value={cell.source} spellCheck={cell.type === "markdown"} onChange={event => updateCell(index, { source: event.target.value })} onBlur={() => cell.type === "markdown" && updateCell(index, { editing: false })}/>} 
          {cell.type === "code" && <ResultView result={cell.result} />}
        </div>
        <div className="cell-actions"><button title="Move up" disabled={index === 0} onClick={() => { needsResetRef.current = true; setValidThrough(-1); setCells(current => current.map((item, position) => position === index - 1 ? current[index] : position === index ? current[index - 1] : item)); }}>↑</button><button title="Delete" onClick={() => { needsResetRef.current = true; setValidThrough(-1); setCells(current => current.filter((_, position) => position !== index)); }}>×</button></div>
      </article>)}</div>
      <div className="add-cells"><button onClick={() => addCell("code")}>+ Code</button><button onClick={() => addCell("markdown")}>+ Explanation</button></div>
    </main>
    <input hidden ref={fileInput} type="file" multiple onChange={event => void attachFiles(event.target.files).catch(error => setNotice({ tone: "bad", text: error.message }))}/>
    <input hidden ref={notebookInput} type="file" accept=".bln,.md,.bl.md" onChange={event => void openFile(event.target.files?.[0])}/>
    {remoteOpen && <div className="modal-backdrop"><form className="modal" onSubmit={event => { event.preventDefault(); setKernelKind("somer"); setRemoteOpen(false); }}><h2>Connect to SOMER</h2><p>The token stays in memory and is never saved by Studio.</p><label>Server URL<input required type="url" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://compute.example.org" /></label><label>Bearer token<input required type="password" value={remoteToken} onChange={event => setRemoteToken(event.target.value)} /></label><div><button type="button" onClick={() => setRemoteOpen(false)}>Cancel</button><button className="primary" type="submit">Connect</button></div></form></div>}
    {packageOpen && <div className="modal-backdrop"><form className="modal" onSubmit={event => { event.preventDefault(); void addPackage(); }}><h2>Add a lesson package</h2><p>Paste an HTTPS URL to a BioLang Studio lesson manifest. Custom manifests are validated but do not carry the registry's manifest checksum. Declared datasets are downloaded separately only when you choose Prepare.</p><label>Manifest URL<input required type="url" value={packageUrl} onChange={event => setPackageUrl(event.target.value)} placeholder="https://example.org/lesson.json" /></label><div><button type="button" onClick={() => setPackageOpen(false)}>Cancel</button><button className="primary" type="submit">Add lesson</button></div></form></div>}
  </div>;
}
