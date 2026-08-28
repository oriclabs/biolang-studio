import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CatalogEntry, DatasetManifest, LessonManifest } from "./content/manifest";
import { validateManifest } from "./content/manifest";
import { installLesson, installedLessons, uninstallLesson } from "./content/installed";
import { fetchRegisteredDataset, fetchRegistry, type RegisteredDatasetManifest, type RegistryEntry, type RegistryKindFilter, type RegistrySource } from "./content/registry";
import type { AttachedFile, ExecutionResult, Kernel, KernelKind, NativeFileReference, RuntimeInfo, StructuredResult, VariableExportFormat, VariableSummary } from "./kernel/protocol";
import { DesktopKernel, desktopAvailable } from "./kernel/desktop-client";
import { SomerKernel } from "./kernel/somer-client";
import { WasmKernel } from "./kernel/wasm-client";
import { forgetRecentNativeDocument, nativeDocumentStatus, nativeDocumentsAvailable, openNativeDocument, readRecentNativeDocuments, rememberNativeDocument, saveNativeDocument, type NativeDocumentBinding, type NativeDocumentKind, type RecentNativeDocument } from "./kernel/native-documents";
import { directives, executableSource, expandMixedMarkdown, parseNotebook, serializeNotebook, type NotebookCell } from "./notebook/format";
import { cacheAttachment, clearContentCache, hasDataset, loadAttachment, loadWorkspaceSession, prepareDataset, prepareRemoteAttachment, removeDataset, requestPersistentStorage, saveWorkspaceSession, sha256, storageStatus, type StorageStatus } from "./storage/content-store";
import { RegistryWorkspace, type RegistryViewState } from "./registry/RegistryWorkspace";
import { assertUnambiguousMountPaths, attachmentId, isSafeWorkspacePath, migratePortableWorkspace, WORKSPACE_SCHEMA_URL, type PortableWorkspace, type WorkspaceAttachment } from "./workspace/format";
import { VariableInspector } from "./VariableInspector";

type Cell = NotebookCell & { result?: ExecutionResult; editing?: boolean };
type Notice = { tone: "info" | "good" | "bad"; text: string } | null;
type WorkspaceView = "notebook" | "registry";
type DisplayBlock = { key: string; step?: NonNullable<NotebookCell["step"]>; items: Array<{ cell: Cell; index: number }> };
type RunRecord = {
  $schema: "https://lang.bio/schemas/studio-run-v1.json";
  schema: 1;
  kind: "biolang-studio-run";
  generatedAt: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  workspace: { name: string };
  notebook: { id: string; filename: string; sourceSha256: string; executedSourceSha256: string; executedThrough: number; codeCells: number };
  runtime: RuntimeInfo;
  inputs: Array<{ path: string; size: number; sha256: string; mediaType: string; sourceKind: WorkspaceAttachment["source"]["kind"] }>;
  timing: { elapsedMs: number };
  error?: string;
};
type NotebookDocument = {
  id: string;
  filename: string;
  cells: Cell[];
  lesson: LessonManifest | null;
  validThrough: number;
  dataReady: Record<string, boolean>;
  dirty: boolean;
  lastRun?: RunRecord;
  nativeFile?: NativeDocumentBinding;
};
type UrlDataDraft = { url: string; path: string; mediaType: string; expectedBytes: string; expectedSha256: string; shared: boolean };

const MAX_BROWSER_DATA_BYTES = 50 * 1024 ** 2;
const MAX_BROWSER_OUTPUT_BYTES = 10 * 1024 ** 2;
const MAX_NATIVE_DATA_BYTES = 20 * 1024 ** 3;
const EMPTY_URL_DATA: UrlDataDraft = { url: "", path: "", mediaType: "text/csv", expectedBytes: "", expectedSha256: "", shared: false };

function suggestedRemotePath(rawUrl: string) {
  try {
    const segment = new URL(rawUrl).pathname.split("/").filter(Boolean).at(-1) ?? "data.txt";
    const decoded = decodeURIComponent(segment).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    return isSafeWorkspacePath(decoded) ? decoded : "data.txt";
  } catch { return ""; }
}

function inferredMediaType(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "json" || extension === "jsonl" || extension === "ndjson") return "application/json";
  if (extension === "tsv" || extension === "tab") return "text/tab-separated-values";
  if (extension === "csv") return "text/csv";
  return "text/plain";
}

function createNotebook(filename = "untitled.bln", source = SAMPLE, lesson: LessonManifest | null = null): NotebookDocument {
  return { id: crypto.randomUUID(), filename, cells: parseNotebook(source), lesson, validThrough: -1, dataReady: {}, dirty: false };
}

function groupNotebookCells(cells: Cell[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  cells.forEach((cell, index) => {
    const previous = blocks.at(-1);
    if (cell.step && previous?.step?.id === cell.step.id) previous.items.push({ cell, index });
    else blocks.push({ key: cell.step?.id ?? cell.id, ...(cell.step ? { step: cell.step } : {}), items: [{ cell, index }] });
  });
  return blocks;
}

const DEFAULT_REGISTRY_FILTERS: RegistryViewState = {
  query: "", kind: "all", category: "", runtime: "", access: "all", verification: "all", sort: "relevance"
};

function registryStateFromUrl(): { view: WorkspaceView; filters: RegistryViewState; entry: string } {
  const params = new URL(location.href).searchParams;
  const kinds = new Set<RegistryKindFilter>(["all", "lesson", "dataset", "provider", "package", "workflow", "tool"]);
  const kind = params.get("kind") as RegistryKindFilter | null;
  return {
    view: params.get("view") === "registry" ? "registry" : "notebook",
    filters: {
      query: params.get("q") ?? "", kind: kind && kinds.has(kind) ? kind : "all",
      category: params.get("category") ?? "", runtime: params.get("runtime") ?? "",
      access: (["public", "registration", "controlled"].includes(params.get("access") ?? "") ? params.get("access") : "all") as RegistryViewState["access"],
      verification: (["verified", "preview"].includes(params.get("trust") ?? "") ? params.get("trust") : "all") as RegistryViewState["verification"],
      sort: (["recent", "name", "size"].includes(params.get("sort") ?? "") ? params.get("sort") : "relevance") as RegistryViewState["sort"],
    },
    entry: params.get("entry") ?? "",
  };
}

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
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function registryEntryKey(entry: RegistryEntry) {
  return `${entry.id}@${entry.version}`;
}

function asDatasetManifest(manifest: RegisteredDatasetManifest, file: RegisteredDatasetManifest["files"][number]): DatasetManifest {
  return {
    id: `${manifest.id}:${file.id}`, title: file.title, path: file.path, url: file.url, bytes: file.bytes,
    sha256: file.sha256, mediaType: file.mediaType, source: manifest.source.landingPage,
    citation: manifest.source.citation, rights: manifest.source.rights
  };
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
  const initialRegistryState = useRef(registryStateFromUrl()).current;
  const kernelRef = useRef<Kernel | null>(null);
  const attachedRef = useRef(new Map<string, AttachedFile>());
  const fileStoreRef = useRef(new Map<string, AttachedFile>());
  const needsResetRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const notebookInput = useRef<HTMLInputElement>(null);
  const workspaceInput = useRef<HTMLInputElement>(null);
  const reattachTargetRef = useRef<WorkspaceAttachment | null>(null);
  const initialDocuments = useRef<NotebookDocument[] | null>(null);
  if (!initialDocuments.current) initialDocuments.current = [createNotebook()];
  const [documents, setDocuments] = useState<NotebookDocument[]>(initialDocuments.current);
  const [activeDocumentId, setActiveDocumentId] = useState(initialDocuments.current[0].id);
  const [lastClosed, setLastClosed] = useState<NotebookDocument | null>(null);
  const [workspaceName, setWorkspaceName] = useState("BioLang workspace");
  const [workspaceNativeFile, setWorkspaceNativeFile] = useState<NativeDocumentBinding | null>(null);
  const [recentNativeDocuments, setRecentNativeDocuments] = useState<RecentNativeDocument[]>(() => readRecentNativeDocuments());
  const [externallyChangedPaths, setExternallyChangedPaths] = useState<Set<string>>(() => new Set());
  const workspaceBaselineRef = useRef("");
  const pendingWorkspaceBaselineRef = useRef(false);
  const [workspaceAttachments, setWorkspaceAttachments] = useState<WorkspaceAttachment[]>([]);
  const workspaceAttachmentsRef = useRef<WorkspaceAttachment[]>(workspaceAttachments);
  workspaceAttachmentsRef.current = workspaceAttachments;
  const [missingAttachmentIds, setMissingAttachmentIds] = useState<Set<string>>(() => new Set());
  const [localStorageStatus, setLocalStorageStatus] = useState<StorageStatus>({ usage: 0, quota: 0, persistent: false });
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [kernelKind, setKernelKind] = useState<KernelKind>("browser");
  const [kernelState, setKernelState] = useState("starting");
  const [kernelEpoch, setKernelEpoch] = useState(0);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice>({ tone: "info", text: "Run any code cell; required earlier cells run automatically." });
  const [variables, setVariables] = useState<VariableSummary[]>([]);
  const [variableRevision, setVariableRevision] = useState(0);
  const [collapsedSteps, setCollapsedSteps] = useState<Set<string>>(() => new Set());
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [urlDataOpen, setUrlDataOpen] = useState(false);
  const [urlDataReview, setUrlDataReview] = useState(false);
  const [urlDataDraft, setUrlDataDraft] = useState<UrlDataDraft>(EMPTY_URL_DATA);
  const [urlDataProgress, setUrlDataProgress] = useState(0);
  const [urlDataDownloading, setUrlDataDownloading] = useState(false);
  const [urlDataError, setUrlDataError] = useState("");
  const [packageOpen, setPackageOpen] = useState(false);
  const [packageUrl, setPackageUrl] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(initialRegistryState.view);
  const [registryEntries, setRegistryEntries] = useState<RegistryEntry[]>([]);
  const [registrySource, setRegistrySource] = useState<RegistrySource | "loading" | "unavailable">("loading");
  const [registryError, setRegistryError] = useState("");
  const [installingId, setInstallingId] = useState("");
  const [registryFilters, setRegistryFilters] = useState<RegistryViewState>(initialRegistryState.filters);
  const [selectedRegistryKey, setSelectedRegistryKey] = useState(initialRegistryState.entry);
  const [registryDatasetDetails, setRegistryDatasetDetails] = useState<RegisteredDatasetManifest | null>(null);
  const [registryDetailLoading, setRegistryDetailLoading] = useState(false);
  const [registryDetailError, setRegistryDetailError] = useState("");
  const [preparedRegistryDatasets, setPreparedRegistryDatasets] = useState<Set<string>>(() => new Set());
  const activeDocument = documents.find(document => document.id === activeDocumentId) ?? documents[0];
  const { cells, lesson, filename, validThrough, dataReady } = activeDocument;
  const visibleAttachments = useMemo(() => workspaceAttachments.filter(attachment => attachment.scope.kind === "workspace" || attachment.scope.notebookId === activeDocumentId), [workspaceAttachments, activeDocumentId]);
  const currentWorkspaceText = useMemo(() => JSON.stringify(makePortableWorkspace(), null, 2), [documents, activeDocumentId, workspaceAttachments, workspaceName]);
  const workspaceDirty = Boolean(workspaceNativeFile && workspaceBaselineRef.current && workspaceBaselineRef.current !== currentWorkspaceText);
  const notebookChangedExternally = Boolean(activeDocument.nativeFile && externallyChangedPaths.has(activeDocument.nativeFile.path));
  const workspaceChangedExternally = Boolean(workspaceNativeFile && externallyChangedPaths.has(workspaceNativeFile.path));

  function updateDocument(id: string, updater: (document: NotebookDocument) => NotebookDocument) {
    setDocuments(current => current.map(document => document.id === id ? updater(document) : document));
  }

  function setCells(next: Cell[] | ((current: Cell[]) => Cell[]), dirty = true) {
    updateDocument(activeDocumentId, document => ({ ...document, cells: typeof next === "function" ? next(document.cells) : next, dirty: dirty || document.dirty }));
  }

  function setFilename(next: string) {
    const safe = next.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    updateDocument(activeDocumentId, document => ({ ...document, filename: safe, dirty: true }));
  }

  function setLesson(next: LessonManifest | null) {
    updateDocument(activeDocumentId, document => ({ ...document, lesson: next }));
  }

  function setValidThrough(next: number | ((current: number) => number)) {
    updateDocument(activeDocumentId, document => ({ ...document, validThrough: typeof next === "function" ? next(document.validThrough) : next }));
  }

  function setDataReady(next: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)) {
    updateDocument(activeDocumentId, document => ({ ...document, dataReady: typeof next === "function" ? next(document.dataReady) : next }));
  }

  useEffect(() => {
    fetch("./catalog/index.json").then(response => response.json()).then((builtIn: CatalogEntry[]) => {
      const installed = installedLessons();
      setCatalog([...builtIn, ...installed.filter(item => !builtIn.some(base => base.id === item.id))]);
    }).catch(() => setCatalog(installedLessons()));
  }, []);

  useEffect(() => { void refreshRegistry(); }, []);
  useEffect(() => { void refreshStorageStatus(); }, []);

  useEffect(() => {
    let active = true;
    loadWorkspaceSession(raw => Boolean(migratePortableWorkspace(JSON.parse(raw)))).then(saved => {
      if (!active || !saved) return;
      const restored = migratePortableWorkspace(JSON.parse(saved.payload));
      const restoredDocuments = restored.notebooks.map(notebook => ({
        id: notebook.id,
        filename: notebook.filename,
        cells: parseNotebook(notebook.source),
        lesson: notebook.lesson ? validateManifest(notebook.lesson) : null,
        validThrough: -1,
        dataReady: notebook.dataReady ?? {},
        dirty: false,
      }));
      setWorkspaceName(restored.name);
      setDocuments(restoredDocuments);
      setWorkspaceAttachments(restored.attachments);
      setActiveDocumentId(restored.activeNotebookId);
      setNotice({ tone: saved.recoveredFrom === "primary" || saved.recoveredFrom === "legacy" ? "info" : "good", text: `${saved.recoveredFrom === "primary" || saved.recoveredFrom === "legacy" ? "Restored" : "Recovered"} ${restoredDocuments.length} notebook${restoredDocuments.length === 1 ? "" : "s"}${saved.recoveredFrom === "primary" || saved.recoveredFrom === "legacy" ? "" : ` from the ${saved.recoveredFrom} session copy`}. Run a cell to rebuild its variables.` });
    }).catch(() => undefined).finally(() => { sessionReadyRef.current = true; });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const restoreLocation = () => {
      const state = registryStateFromUrl();
      setWorkspaceView(state.view); setRegistryFilters(state.filters); setSelectedRegistryKey(state.entry);
    };
    addEventListener("popstate", restoreLocation);
    return () => removeEventListener("popstate", restoreLocation);
  }, []);

  useEffect(() => {
    const url = new URL(location.href);
    const keys = ["view", "q", "kind", "category", "runtime", "access", "trust", "sort", "entry"];
    keys.forEach(key => url.searchParams.delete(key));
    if (workspaceView === "registry") {
      url.searchParams.set("view", "registry");
      if (registryFilters.query) url.searchParams.set("q", registryFilters.query);
      if (registryFilters.kind !== "all") url.searchParams.set("kind", registryFilters.kind);
      if (registryFilters.category) url.searchParams.set("category", registryFilters.category);
      if (registryFilters.runtime) url.searchParams.set("runtime", registryFilters.runtime);
      if (registryFilters.access !== "all") url.searchParams.set("access", registryFilters.access);
      if (registryFilters.verification !== "all") url.searchParams.set("trust", registryFilters.verification);
      if (registryFilters.sort !== "relevance") url.searchParams.set("sort", registryFilters.sort);
      if (selectedRegistryKey) url.searchParams.set("entry", selectedRegistryKey);
    }
    history.replaceState(history.state, "", url);
  }, [workspaceView, registryFilters, selectedRegistryKey]);

  useEffect(() => {
    let alive = true;
    const kernel: Kernel = kernelKind === "desktop" ? new DesktopKernel(activeDocumentId) : kernelKind === "somer" ? new SomerKernel(remoteUrl, remoteToken) : new WasmKernel();
    kernelRef.current?.dispose(); kernelRef.current = kernel; attachedRef.current.clear(); setKernelState("starting"); setVariables([]); setVariableRevision(current => current + 1);
    updateDocument(activeDocumentId, document => ({ ...document, validThrough: -1, cells: document.cells.map(cell => cell.type === "code" && cell.result ? { ...cell, status: "stale" } : cell) }));
    kernel.initialize().then(async () => {
      const applicable = workspaceAttachments.filter(attachment => attachment.scope.kind === "workspace" || attachment.scope.notebookId === activeDocumentId);
      for (const attachment of applicable) {
        if (kernel.hasAttachment && await kernel.hasAttachment(attachment.path, attachment.sha256)) {
          setMissingAttachmentIds(current => { const next = new Set(current); next.delete(attachment.id); return next; });
          continue;
        }
        const file = await resolveAttachment(attachment);
        if (!file) continue;
        attachedRef.current.set(file.path, file); await kernel.attach(file);
      }
      if (alive) setKernelState("ready");
    }).catch(error => alive && (setKernelState("failed"), setNotice({ tone: "bad", text: error.message })));
    return () => { alive = false; kernel.dispose(); };
  }, [kernelKind, remoteUrl, remoteToken, activeDocumentId, kernelEpoch]);

  useEffect(() => {
    if (!sessionReadyRef.current) return;
    const portable = makePortableWorkspace();
    const timer = setTimeout(() => void saveWorkspaceSession(JSON.stringify(portable)).catch(error => setNotice({ tone: "bad", text: `Workspace autosave failed: ${error instanceof Error ? error.message : String(error)}` })), 800);
    return () => clearTimeout(timer);
  }, [documents, activeDocumentId, workspaceAttachments, workspaceName]);

  useEffect(() => {
    if (!pendingWorkspaceBaselineRef.current || !workspaceNativeFile) return;
    workspaceBaselineRef.current = currentWorkspaceText;
    pendingWorkspaceBaselineRef.current = false;
  }, [currentWorkspaceText, workspaceNativeFile]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!documents.some(document => document.dirty) && !workspaceDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", warnBeforeLeaving);
    return () => removeEventListener("beforeunload", warnBeforeLeaving);
  }, [documents, workspaceDirty]);

  useEffect(() => {
    if (!nativeDocumentsAvailable()) return;
    let alive = true;
    const checkExternalChanges = async () => {
      const bindings = [activeDocument.nativeFile, workspaceNativeFile].filter((binding): binding is NativeDocumentBinding => Boolean(binding));
      if (!bindings.length) return;
      const checked = await Promise.all(bindings.map(async binding => {
        try { return { binding, status: await nativeDocumentStatus(binding) }; }
        catch { return { binding, status: { exists: false, changed: true } }; }
      }));
      if (!alive) return;
      let newlyChanged = "";
      setExternallyChangedPaths(current => {
        const next = new Set(current);
        for (const { binding, status } of checked) {
          if (status.changed) {
            if (!next.has(binding.path)) newlyChanged ||= binding.filename;
            next.add(binding.path);
          } else next.delete(binding.path);
        }
        return next;
      });
      if (newlyChanged) setNotice({ tone: "info", text: `${newlyChanged} changed outside Studio. Reload it or confirm overwrite when saving.` });
    };
    void checkExternalChanges();
    addEventListener("focus", checkExternalChanges);
    return () => { alive = false; removeEventListener("focus", checkExternalChanges); };
  }, [activeDocument.nativeFile, workspaceNativeFile]);

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (nativeDocumentsAvailable()) void saveDesktopNotebook(event.shiftKey);
        else saveBrowserFile();
      } else if (key === "o") {
        event.preventDefault(); openFile();
      }
    };
    addEventListener("keydown", shortcuts);
    return () => removeEventListener("keydown", shortcuts);
  }, [activeDocumentId, documents, filename]);

  const codeCount = useMemo(() => cells.filter(cell => cell.type === "code").length, [cells]);
  const displayBlocks = useMemo(() => groupNotebookCells(cells), [cells]);
  const installedLessonNames = useMemo(() => new Set(catalog.map(item => item.id)), [catalog]);
  const selectedRegistryEntry = useMemo(() => registryEntries.find(entry => registryEntryKey(entry) === selectedRegistryKey) ?? null, [registryEntries, selectedRegistryKey]);

  useEffect(() => {
    let active = true;
    setRegistryDatasetDetails(null); setRegistryDetailError("");
    if (selectedRegistryEntry?.kind !== "dataset") { setRegistryDetailLoading(false); return () => { active = false; }; }
    setRegistryDetailLoading(true);
    fetchRegisteredDataset(selectedRegistryEntry).then(async manifest => {
      if (!active) return;
      setRegistryDatasetDetails(manifest);
      const cached = await Promise.all(manifest.files.map(file => hasDataset(asDatasetManifest(manifest, file))));
      if (active && cached.every(Boolean)) setPreparedRegistryDatasets(current => new Set(current).add(manifest.id));
    }).catch(error => active && setRegistryDetailError(error instanceof Error ? error.message : String(error)))
      .finally(() => active && setRegistryDetailLoading(false));
    return () => { active = false; };
  }, [selectedRegistryEntry]);

  function makePortableWorkspace(): PortableWorkspace {
    return {
      $schema: WORKSPACE_SCHEMA_URL,
      schema: 3,
      kind: "biolang-workspace",
      name: workspaceName.trim() || "BioLang workspace",
      activeNotebookId: activeDocumentId,
      notebooks: documents.map(document => ({
        id: document.id,
        filename: document.filename.trim() || "untitled.bln",
        source: serializeNotebook(document.cells),
        ...(document.lesson ? { lesson: document.lesson } : {}),
        dataReady: document.dataReady,
        attachmentIds: workspaceAttachments.filter(attachment => attachment.scope.kind === "workspace" || attachment.scope.notebookId === document.id).map(attachment => attachment.id),
      })),
      attachments: workspaceAttachments,
    };
  }

  async function resolveAttachment(attachment: WorkspaceAttachment) {
    const inMemory = fileStoreRef.current.get(attachment.id);
    if (inMemory) return inMemory;
    let file: AttachedFile | null = null;
    if (attachment.source.kind === "dataset" && await hasDataset(attachment.source.dataset)) file = await prepareDataset(attachment.source.dataset);
    else file = await loadAttachment(attachment);
    if (file) {
      fileStoreRef.current.set(attachment.id, file);
      setMissingAttachmentIds(current => { const next = new Set(current); next.delete(attachment.id); return next; });
    } else {
      setMissingAttachmentIds(current => new Set(current).add(attachment.id));
      if (attachment.source.kind === "dataset") {
        const datasetId = attachment.source.dataset.id;
        setDocuments(current => current.map(document => {
        if (attachment.scope.kind === "notebook" && attachment.scope.notebookId !== document.id) return document;
        return { ...document, dataReady: { ...document.dataReady, [datasetId]: false } };
        }));
      }
    }
    return file;
  }

  function updateCell(index: number, patch: Partial<Cell>) {
    updateDocument(activeDocumentId, document => ({
      ...document,
      cells: document.cells.map((cell, position) => position === index ? { ...cell, ...patch } : cell),
      dirty: patch.source !== undefined ? true : document.dirty,
    }));
    if (patch.source !== undefined) { needsResetRef.current = true; setValidThrough(current => Math.min(current, index - 1)); }
  }

  function navigateWorkspace(view: WorkspaceView) {
    const url = new URL(location.href);
    if (view === "registry") url.searchParams.set("view", "registry");
    else ["view", "q", "kind", "category", "runtime", "access", "trust", "sort", "entry"].forEach(key => url.searchParams.delete(key));
    history.pushState(history.state, "", url); setWorkspaceView(view);
    if (view === "registry" && notice?.text === "Run any code cell; required earlier cells run automatically.") setNotice(null);
  }

  function updateRegistryFilters(patch: Partial<RegistryViewState>) {
    setRegistryFilters(current => ({ ...current, ...patch }));
  }

  function selectRegistryEntry(entry: RegistryEntry) {
    setSelectedRegistryKey(registryEntryKey(entry));
  }

  async function openRegistryLesson(entry: RegistryEntry) {
    const installed = catalog.find(item => item.id === entry.name);
    if (!installed) return;
    await loadLesson(installed); navigateWorkspace("notebook");
  }

  async function copyRegistryCommand(entry: RegistryEntry) {
    const command = `bl data fetch ${entry.id}`;
    try {
      await navigator.clipboard.writeText(command);
      setNotice({ tone: "good", text: `Copied: ${command}` });
    } catch { setNotice({ tone: "info", text: command }); }
  }

  async function refreshVariables() {
    try { setVariables(await kernelRef.current!.listVariables()); } catch { setVariables([]); }
    finally { setVariableRevision(current => current + 1); }
  }

  async function runTo(end: number, restart = false) {
    if (!kernelRef.current || running || kernelState !== "ready") return;
    setRunning(true); setNotice(null);
    stopRequestedRef.current = false;
    const runStartedAt = new Date();
    const runStarted = performance.now();
    const runNotebookId = activeDocumentId;
    const runFilename = filename;
    const runSource = serializeNotebook(cells);
    const executedSource = cells.slice(0, end + 1).filter(cell => cell.type === "code" && !directives(cell.source).skip).map(cell => executableSource(cell.source)).filter(Boolean).join("\n\n");
    const runInputs = visibleAttachments.filter(attachment => !missingAttachmentIds.has(attachment.id)).map(attachment => ({
      path: attachment.path, size: attachment.size, sha256: attachment.sha256,
      mediaType: attachment.mediaType, sourceKind: attachment.source.kind,
    }));
    let runSucceeded = false;
    let runError: string | undefined;
    let start = Math.max(0, validThrough + 1);
    try {
      if (restart || needsResetRef.current || end <= validThrough || kernelKind === "somer") { await kernelRef.current.reset(); needsResetRef.current = false; start = 0; setValidThrough(-1); }
      if (kernelKind === "somer") {
        const runnable = cells.slice(0, end + 1).filter(cell => cell.type === "code" && !directives(cell.source).skip).map(cell => executableSource(cell.source)).filter(Boolean);
        const result = await kernelRef.current.execute(runnable.join("\n\n"));
        updateCell(end, { status: result.ok ? "done" : "error", result });
        if (!result.ok) { runError = result.error ?? "Remote execution failed."; setNotice({ tone: "bad", text: runError }); return; }
        runSucceeded = true;
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
        if (!result.ok) { runError = result.error ?? "Execution failed."; setValidThrough(index - 1); setNotice({ tone: "bad", text: `Stopped at cell ${index + 1}: ${runError}` }); return; }
        setValidThrough(index);
      }
      await refreshVariables();
      runSucceeded = true;
      setNotice({ tone: "good", text: `Finished through cell ${end + 1}. Earlier code cells were run when needed.` });
    } catch (error) {
      runError = stopRequestedRef.current ? "Cancelled by user" : error instanceof Error ? error.message : String(error);
      setNotice(stopRequestedRef.current
        ? { tone: "info", text: "Execution stopped. The next run will replay this notebook from a clean interpreter." }
        : { tone: "bad", text: runError });
    } finally {
      const runtime = await kernelRef.current?.runtimeInfo?.().catch(() => undefined) ?? {
        runtime: kernelKind, description: kernelRef.current?.capabilities.description ?? `${kernelKind} BioLang runtime`,
      };
      const record: RunRecord = {
        $schema: "https://lang.bio/schemas/studio-run-v1.json", schema: 1, kind: "biolang-studio-run",
        generatedAt: new Date().toISOString(), startedAt: runStartedAt.toISOString(), finishedAt: new Date().toISOString(),
        success: runSucceeded, workspace: { name: workspaceName.trim() || "BioLang workspace" },
        notebook: {
          id: runNotebookId, filename: runFilename, sourceSha256: await sha256(runSource),
          executedSourceSha256: await sha256(executedSource), executedThrough: end,
          codeCells: cells.slice(0, end + 1).filter(cell => cell.type === "code" && !directives(cell.source).skip).length,
        },
        runtime, inputs: runInputs, timing: { elapsedMs: Math.round(performance.now() - runStarted) },
        ...(runError ? { error: runError } : {}),
      };
      updateDocument(runNotebookId, document => ({ ...document, lastRun: record }));
      setRunning(false);
    }
  }

  async function stopRun() {
    try {
      stopRequestedRef.current = true;
      await kernelRef.current?.cancel();
      needsResetRef.current = true;
      setValidThrough(-1);
      setNotice({ tone: "info", text: "Execution stopped. The next run will replay this notebook from a clean interpreter." });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function loadLesson(entry: CatalogEntry, propagateError = false) {
    try {
      const existing = documents.find(document => document.lesson?.id === entry.id);
      if (existing) { setActiveDocumentId(existing.id); return; }
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
      const document = createNotebook(`${manifest.id}.bln`, source, manifest);
      const states = Object.fromEntries(await Promise.all(manifest.datasets.map(async dataset => {
        const cached = await hasDataset(dataset);
        if (cached) {
          const file = await prepareDataset(dataset);
          await registerAttachment(file, dataset.mediaType, { kind: "dataset", dataset }, { kind: "notebook", notebookId: document.id }, false);
        }
        return [dataset.id, cached];
      })));
      document.dataReady = states;
      setDocuments(current => [...current, document]); setActiveDocumentId(document.id); needsResetRef.current = false;
      setNotice({ tone: "info", text: `Opened ${manifest.title} in a new tab. Prepare its declared data before running.` });
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
      if (kernelKind === "desktop" && kernelRef.current.fetchRemote) {
        if (dataset.bytes > MAX_NATIVE_DATA_BYTES) throw new Error(`${dataset.title} exceeds Studio Desktop's ${displayBytes(MAX_NATIVE_DATA_BYTES)} per-file safety limit.`);
        setNotice({ tone: "info", text: `Streaming ${dataset.title} into private native storage…` });
        const native = await kernelRef.current.fetchRemote({
          url: dataset.url, path: dataset.path, mediaType: dataset.mediaType,
          expectedBytes: dataset.bytes, expectedSha256: dataset.sha256,
        });
        registerNativeReference(native, { kind: "dataset", dataset }, { kind: "notebook", notebookId: activeDocumentId });
        setDataReady(current => ({ ...current, [id]: true }));
        setNotice({ tone: "good", text: `${dataset.title} was streamed to private native storage, checksum-verified, and mounted as ${dataset.path}.` });
        return;
      }
      setNotice({ tone: "info", text: `Downloading ${dataset.title} from its declared source…` });
      const file = await prepareDataset(dataset, loaded => setProgress(current => ({ ...current, [id]: loaded })));
      await registerAttachment(file, dataset.mediaType, { kind: "dataset", dataset }, { kind: "notebook", notebookId: activeDocumentId });
      setDataReady(current => ({ ...current, [id]: true }));
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
      navigateWorkspace("notebook");
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
    finally { setInstallingId(""); }
  }

  async function prepareRegistryDataset(entry: RegistryEntry, existingManifest?: RegisteredDatasetManifest) {
    if (!kernelRef.current) return;
    setInstallingId(entry.id);
    try {
      const manifest = existingManifest ?? await fetchRegisteredDataset(entry);
      if (manifest.provider !== "oriclabs/direct-https") throw new Error(`Provider '${manifest.provider}' needs a Studio adapter that is not installed.`);
      if (manifest.access.kind === "controlled") throw new Error("Controlled-access data must be prepared by BioLang Desktop or SOMER with credentials kept outside the registry.");
      if (manifest.access.requiresAcceptance && !window.confirm(`Review and accept the source terms for ${manifest.title}${manifest.access.termsUrl ? `:\n${manifest.access.termsUrl}` : ""}`)) return;
      const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      if (kernelKind === "browser" && total > 50 * 1024 ** 2) throw new Error(`${manifest.title} is larger than the 50 MB browser guidance limit. Use bl data fetch, BioLang Desktop, or SOMER.`);
      for (const declared of manifest.files) {
        if (kernelKind !== "desktop" && !declared.mediaType.startsWith("text/") && declared.mediaType !== "application/json") throw new Error(`${declared.title} is binary. Prepare it with bl data fetch or a native kernel.`);
        const key = `${entry.id}:${declared.id}`;
        const dataset = asDatasetManifest(manifest, declared);
        if (kernelKind === "desktop" && kernelRef.current.fetchRemote) {
          if (declared.bytes > MAX_NATIVE_DATA_BYTES) throw new Error(`${declared.title} exceeds Studio Desktop's ${displayBytes(MAX_NATIVE_DATA_BYTES)} per-file safety limit.`);
          setNotice({ tone: "info", text: `Streaming ${declared.title} into private native storage…` });
          const native = await kernelRef.current.fetchRemote({
            url: declared.url, path: declared.path, mediaType: declared.mediaType,
            expectedBytes: declared.bytes, expectedSha256: declared.sha256,
          });
          registerNativeReference(native, { kind: "dataset", dataset }, { kind: "workspace" });
          setDataReady(current => ({ ...current, [key]: true }));
          continue;
        }
        setNotice({ tone: "info", text: `Downloading ${declared.title} from ${manifest.provider}…` });
        const file = await prepareDataset(dataset, loaded => setProgress(current => ({ ...current, [key]: loaded })));
        await registerAttachment(file, declared.mediaType, { kind: "dataset", dataset }, { kind: "workspace" });
        setDataReady(current => ({ ...current, [key]: true }));
      }
      setPreparedRegistryDatasets(current => new Set(current).add(entry.id));
      setNotice({ tone: "good", text: `${manifest.title} was checksum-verified, cached, and attached. Use the declared file paths in this notebook.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
    finally { setInstallingId(""); }
  }

  async function removePackage(entry: CatalogEntry) {
    const stored = installedLessons().find(item => item.id === entry.id);
    if (stored?.datasets) await Promise.all(stored.datasets.map(removeDataset));
    const remaining = uninstallLesson(entry.id); setCatalog(remaining);
    setDocuments(current => current.map(document => document.lesson?.id === entry.id ? { ...document, lesson: null, dataReady: {}, dirty: true } : document));
    const retainedAttachments = workspaceAttachmentsRef.current.filter(attachment => attachment.source.kind !== "dataset" || !stored?.datasets?.some(dataset => dataset.sha256 === attachment.sha256));
    workspaceAttachmentsRef.current = retainedAttachments; setWorkspaceAttachments(retainedAttachments);
    setKernelEpoch(current => current + 1);
    setNotice({ tone: "info", text: `${entry.title} and its cached declared data were removed from this browser.` });
  }

  async function attachFiles(list: FileList | null) {
    if (!list || !kernelRef.current) return;
    const target = reattachTargetRef.current;
    try {
      if (target && list.length !== 1) throw new Error(`Choose exactly one file to reattach ${target.path}.`);
      for (const file of [...list]) {
        if (kernelKind === "browser" && file.size > 50 * 1024 ** 2) throw new Error("Files over 50 MB are better opened in BioLang Desktop or sent to SOMER.");
        if (file.type && !file.type.startsWith("text/") && file.type !== "application/json") throw new Error(`${file.name} is binary. Use BioLang Desktop or SOMER with a native reader.`);
        const attached = await cacheAttachment({ path: file.name, contents: await file.text(), size: file.size });
        if (target && (attached.path !== target.path || attached.sha256?.toLowerCase() !== target.sha256.toLowerCase())) throw new Error(`${file.name} does not match the recorded name and SHA-256 for ${target.path}.`);
        await registerAttachment(attached, (target?.mediaType ?? file.type) || "text/plain", target?.source ?? { kind: "local" }, target?.scope ?? { kind: "notebook", notebookId: activeDocumentId });
      }
    } finally {
      reattachTargetRef.current = null;
    }
    setNotice({ tone: "good", text: `${list.length} local file${list.length === 1 ? "" : "s"} attached to this kernel.` });
  }

  async function attachNativeFiles(target?: WorkspaceAttachment) {
    const kernel = kernelRef.current;
    if (!kernel?.importLocalFiles) throw new Error("Native file selection is not available in this Studio build.");
    const selected = await kernel.importLocalFiles();
    if (!selected.length) return;
    if (target && selected.length !== 1) throw new Error(`Choose exactly one file to reattach ${target.path}.`);
    for (const file of selected) {
      if (target && (file.path !== target.path || file.sha256.toLowerCase() !== target.sha256.toLowerCase())) throw new Error(`${file.path} does not match the recorded name and SHA-256 for ${target.path}.`);
      registerNativeReference(file, target?.source ?? { kind: "local" }, target?.scope ?? { kind: "notebook", notebookId: activeDocumentId });
    }
    setNotice({ tone: "good", text: `${selected.length} file${selected.length === 1 ? "" : "s"} streamed into this notebook's private native data directory.` });
  }

  function validatedUrlDataDraft() {
    let url: URL;
    try { url = new URL(urlDataDraft.url); }
    catch { throw new Error("Enter a complete HTTPS data URL."); }
    if (url.protocol !== "https:") throw new Error("Remote data URLs must use HTTPS.");
    if (url.username || url.password) throw new Error("Do not put credentials in a data URL. Use Desktop or SOMER for authenticated sources.");
    const sensitiveQueryNames = /^(?:access[_-]?token|api[_-]?key|auth|authorization|credential|password|signature|sig|token|x-amz-signature|x-goog-signature)$/i;
    if ([...url.searchParams.keys()].some(name => sensitiveQueryNames.test(name))) throw new Error("This URL appears to contain a credential or signed token. Use Desktop or SOMER so secrets are not saved in workspace provenance.");
    url.hash = "";
    const path = urlDataDraft.path.trim();
    if (!isSafeWorkspacePath(path)) throw new Error("Mount path must be relative and cannot contain '..' or a drive prefix.");
    const maximumBytes = kernelKind === "desktop" ? MAX_NATIVE_DATA_BYTES : MAX_BROWSER_DATA_BYTES;
    const expectedBytes = urlDataDraft.expectedBytes.trim() ? Number(urlDataDraft.expectedBytes) : undefined;
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximumBytes)) throw new Error(`Expected size must be a whole number from 0 to ${maximumBytes} bytes.`);
    const expectedSha256 = urlDataDraft.expectedSha256.trim().toLowerCase() || undefined;
    if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("SHA-256 must contain exactly 64 hexadecimal characters.");
    const scope: WorkspaceAttachment["scope"] = urlDataDraft.shared ? { kind: "workspace" } : { kind: "notebook", notebookId: activeDocumentId };
    const collides = workspaceAttachmentsRef.current.some(attachment => attachment.path === path &&
      (scope.kind === "workspace" || attachment.scope.kind === "workspace" || attachment.scope.notebookId === activeDocumentId));
    if (collides) throw new Error(`${path} is already attached in this scope. Detach it or choose another mount path.`);
    return { url: url.href, path, mediaType: urlDataDraft.mediaType, expectedBytes, expectedSha256, scope };
  }

  function reviewUrlData() {
    try { validatedUrlDataDraft(); setUrlDataError(""); setUrlDataReview(true); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setUrlDataError(message); setNotice({ tone: "bad", text: message }); }
  }

  function closeUrlData() {
    if (urlDataDownloading) return;
    setUrlDataOpen(false); setUrlDataReview(false); setUrlDataDraft(EMPTY_URL_DATA); setUrlDataProgress(0); setUrlDataError("");
  }

  async function downloadUrlData() {
    if (!kernelRef.current) return;
    try {
      const request = validatedUrlDataDraft();
      setUrlDataDownloading(true); setUrlDataProgress(0); setUrlDataError("");
      setNotice({ tone: "info", text: `Downloading ${request.path} from the approved HTTPS source…` });
      if (kernelKind === "desktop" && kernelRef.current.fetchRemote) {
        const prepared = await kernelRef.current.fetchRemote(request);
        registerNativeReference(prepared, {
          kind: "url", url: request.url, sourceBytes: prepared.sourceBytes,
          sourceSha256: prepared.sourceSha256, retrievedAt: new Date().toISOString()
        }, request.scope);
      } else {
        const prepared = await prepareRemoteAttachment({ ...request, maximumBytes: MAX_BROWSER_DATA_BYTES }, setUrlDataProgress);
        await registerAttachment(prepared.file, request.mediaType, {
          kind: "url", url: request.url, sourceBytes: prepared.sourceBytes,
          sourceSha256: prepared.sourceSha256, retrievedAt: new Date().toISOString()
        }, request.scope);
      }
      const checked = request.expectedSha256 ? "matched the supplied checksum" : "recorded its observed checksum";
      setNotice({ tone: "good", text: `${request.path} ${checked}, was cached, and is ready in ${request.scope.kind === "workspace" ? "all notebooks" : "this notebook"}.` });
      setUrlDataOpen(false); setUrlDataReview(false); setUrlDataDraft(EMPTY_URL_DATA); setUrlDataProgress(0); setUrlDataError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); setUrlDataError(message); setNotice({ tone: "bad", text: message });
    } finally { setUrlDataDownloading(false); }
  }

  function saveBrowserFile() {
    const blob = new Blob([serializeNotebook(cells)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename.trim() || "untitled.bln"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    updateDocument(activeDocumentId, document => ({ ...document, dirty: false }));
  }

  async function openBrowserFile(file?: File) {
    if (!file) return;
    const document = createNotebook(file.name, await file.text());
    setDocuments(current => [...current, document]); setActiveDocumentId(document.id); needsResetRef.current = false;
  }

  function nativeBinding(document: NativeDocumentBinding): NativeDocumentBinding {
    return { path: document.path, filename: document.filename, size: document.size, sha256: document.sha256, modifiedMs: document.modifiedMs };
  }

  function rememberNative(kind: NativeDocumentKind, document: NativeDocumentBinding) {
    setRecentNativeDocuments(rememberNativeDocument(kind, document));
  }

  function clearExternalChange(path: string) {
    setExternallyChangedPaths(current => { const next = new Set(current); next.delete(path); return next; });
  }

  async function openDesktopNotebook(path?: string, reload = false) {
    try {
      const existing = path ? documents.find(document => document.nativeFile?.path === path) : undefined;
      if (existing && !reload) { setActiveDocumentId(existing.id); return; }
      if (existing?.dirty && !window.confirm(`${existing.filename} has unsaved changes. Reload it from disk?`)) return;
      const opened = await openNativeDocument("notebook", path);
      if (!opened) return;
      const binding = nativeBinding(opened);
      if (existing) {
        updateDocument(existing.id, document => ({ ...document, filename: opened.filename, cells: parseNotebook(opened.contents), validThrough: -1, dirty: false, nativeFile: binding }));
        setActiveDocumentId(existing.id);
      } else {
        const document = createNotebook(opened.filename, opened.contents);
        document.nativeFile = binding;
        setDocuments(current => [...current, document]); setActiveDocumentId(document.id);
      }
      clearExternalChange(opened.path); rememberNative("notebook", binding); needsResetRef.current = false;
      setNotice({ tone: "good", text: `Opened ${opened.filename} from Desktop storage.` });
    } catch (error) {
      if (path) setRecentNativeDocuments(forgetRecentNativeDocument(path));
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function saveDesktopNotebook(saveAs = false, destination?: string, overwrite = false) {
    const document = documents.find(item => item.id === activeDocumentId);
    if (!document) return;
    try {
      const sameFile = !saveAs && !destination ? document.nativeFile : undefined;
      const result = await saveNativeDocument({
        kind: "notebook", path: destination ?? sameFile?.path,
        suggestedName: document.filename.trim() || "untitled.bln",
        contents: serializeNotebook(document.cells), expectedSha256: sameFile?.sha256, overwrite,
      });
      if (!result) return;
      if (result.status === "conflict") {
        if (window.confirm(`${result.path} changed outside Studio or already exists. Overwrite it with this notebook?`)) await saveDesktopNotebook(true, result.path, true);
        return;
      }
      if (!result.document) throw new Error("Desktop did not return the saved notebook metadata.");
      const binding = nativeBinding(result.document);
      updateDocument(document.id, current => ({ ...current, filename: result.document!.filename, nativeFile: binding, dirty: false }));
      clearExternalChange(binding.path); rememberNative("notebook", binding);
      setNotice({ tone: "good", text: `Saved ${binding.filename} atomically.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
  }

  function saveFile() {
    if (nativeDocumentsAvailable()) void saveDesktopNotebook();
    else saveBrowserFile();
  }

  function openFile() {
    if (nativeDocumentsAvailable()) void openDesktopNotebook();
    else notebookInput.current?.click();
  }

  async function registerAttachment(file: AttachedFile, mediaType: string, source: WorkspaceAttachment["source"], scope: WorkspaceAttachment["scope"], attach = true) {
    const stored = file.sha256 ? file : await cacheAttachment(file);
    const id = attachmentId(stored.path, stored.sha256!);
    fileStoreRef.current.set(id, stored);
    const record: WorkspaceAttachment = { id, path: stored.path, size: stored.size, sha256: stored.sha256!, mediaType, scope, source };
    setMissingAttachmentIds(current => { const next = new Set(current); next.delete(id); return next; });
    const next = [...workspaceAttachmentsRef.current.filter(item => {
      if (item.id === id) return false;
      if (item.path !== record.path || item.scope.kind !== record.scope.kind) return true;
      return item.scope.kind === "notebook" && record.scope.kind === "notebook" && item.scope.notebookId !== record.scope.notebookId;
    }), record];
    assertUnambiguousMountPaths(next, documents.map(document => document.id));
    workspaceAttachmentsRef.current = next; setWorkspaceAttachments(next);
    if (attach && (scope.kind === "workspace" || scope.notebookId === activeDocumentId) && kernelRef.current) {
      attachedRef.current.set(stored.path, stored); await kernelRef.current.attach(stored);
    }
    await refreshStorageStatus();
  }

  function registerNativeReference(file: NativeFileReference, source: WorkspaceAttachment["source"], scope: WorkspaceAttachment["scope"]) {
    const id = attachmentId(file.path, file.sha256);
    const record: WorkspaceAttachment = { id, path: file.path, size: file.size, sha256: file.sha256, mediaType: file.mediaType, scope, source };
    const next = [...workspaceAttachmentsRef.current.filter(item => {
      if (item.id === id) return false;
      if (item.path !== record.path || item.scope.kind !== record.scope.kind) return true;
      return item.scope.kind === "notebook" && record.scope.kind === "notebook" && item.scope.notebookId !== record.scope.notebookId;
    }), record];
    assertUnambiguousMountPaths(next, documents.map(document => document.id));
    workspaceAttachmentsRef.current = next; setWorkspaceAttachments(next);
    setMissingAttachmentIds(current => { const updated = new Set(current); updated.delete(id); return updated; });
  }

  async function publishWorkspaceOutput(variable: VariableSummary, format: VariableExportFormat) {
    const kernel = kernelRef.current;
    if (!kernel?.publishVariable) {
      setNotice({ tone: "info", text: "This runtime cannot publish an interactive variable. Declare a SOMER output file instead." });
      return;
    }
    const extension = format === "text" ? "txt" : format;
    const requested = window.prompt("Workspace path for this output", `outputs/${variable.name}.${extension}`);
    if (requested === null) return;
    const path = requested.trim().replaceAll("\\", "/");
    if (!isSafeWorkspacePath(path)) {
      setNotice({ tone: "bad", text: "Output paths must be relative and cannot contain '..'." });
      return;
    }
    const shared = window.confirm("Make this output available to every notebook in this workspace? Choose Cancel to keep it in this notebook only.");
    const scope: WorkspaceAttachment["scope"] = shared ? { kind: "workspace" } : { kind: "notebook", notebookId: activeDocumentId };
    const collision = workspaceAttachmentsRef.current.some(attachment => attachment.path === path &&
      (scope.kind === "workspace" || attachment.scope.kind === "workspace" || attachment.scope.notebookId === activeDocumentId));
    if (collision) {
      setNotice({ tone: "bad", text: `${path} already identifies an input or output in this scope. Detach it or publish under a new versioned path.` });
      return;
    }
    try {
      const published = await kernel.publishVariable(variable.name, format, path, MAX_BROWSER_OUTPUT_BYTES);
      const source: WorkspaceAttachment["source"] = {
        kind: "output",
        producerNotebookId: activeDocument.id,
        producerNotebookFilename: activeDocument.filename,
        variable: variable.name,
        format,
        createdAt: new Date().toISOString(),
        ...(activeDocument.lastRun?.notebook.executedSourceSha256 ? { executedSourceSha256: activeDocument.lastRun.notebook.executedSourceSha256 } : {}),
      };
      if (published.bytes) {
        const contents = new TextDecoder().decode(published.bytes);
        const stored = await cacheAttachment({ path, contents, size: published.bytes.byteLength });
        await registerAttachment(stored, published.mediaType, source, scope);
      } else {
        if (!published.sha256) throw new Error("Desktop did not return an output checksum.");
        registerNativeReference(published, source, scope);
      }
      setNotice({ tone: "good", text: `Published ${variable.name} as ${path}; it is checksum-pinned and available to ${shared ? "every notebook" : "this notebook"}.` });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }

  function newNotebook() {
    const document = createNotebook(`untitled-${documents.length + 1}.bln`, "# New notebook\n\nWrite what you want to find out.\n");
    document.dirty = true;
    setDocuments(current => [...current, document]); setActiveDocumentId(document.id); setWorkspaceView("notebook");
  }

  function switchNotebook(id: string) {
    if (id === activeDocumentId || running) return;
    needsResetRef.current = false; setCollapsedSteps(new Set()); setActiveDocumentId(id);
    setNotice({ tone: "info", text: "Notebook variables are isolated. Saved outputs remain visible but replay before relying on them." });
  }

  function closeNotebook(id: string) {
    if (running) return;
    const closing = documents.find(document => document.id === id);
    if (!closing || (closing.dirty && !window.confirm(`Close ${closing.filename} without saving its latest changes?`))) return;
    setLastClosed(closing);
    const retainedAttachments = workspaceAttachmentsRef.current.filter(attachment => attachment.scope.kind === "workspace" || attachment.scope.notebookId !== id);
    workspaceAttachmentsRef.current = retainedAttachments; setWorkspaceAttachments(retainedAttachments);
    if (documents.length === 1) {
      const replacement = createNotebook(); setDocuments([replacement]); setActiveDocumentId(replacement.id); return;
    }
    const index = documents.findIndex(document => document.id === id);
    const remaining = documents.filter(document => document.id !== id);
    setDocuments(remaining);
    if (id === activeDocumentId) setActiveDocumentId(remaining[Math.min(index, remaining.length - 1)].id);
  }

  function reopenNotebook() {
    if (!lastClosed) return;
    const restored = { ...lastClosed, id: documents.some(document => document.id === lastClosed.id) ? crypto.randomUUID() : lastClosed.id };
    setDocuments(current => [...current, restored]); setActiveDocumentId(restored.id); setLastClosed(null);
  }

  function saveBrowserWorkspaceFile() {
    const blob = new Blob([currentWorkspaceText], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${workspaceName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "biolang-workspace"}.blw`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveDesktopWorkspace(saveAs = false, destination?: string, overwrite = false) {
    try {
      const sameFile = !saveAs && !destination ? workspaceNativeFile : undefined;
      const suggestedName = `${workspaceName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "biolang-workspace"}.blw`;
      const result = await saveNativeDocument({
        kind: "workspace", path: destination ?? sameFile?.path, suggestedName,
        contents: currentWorkspaceText, expectedSha256: sameFile?.sha256, overwrite,
      });
      if (!result) return;
      if (result.status === "conflict") {
        if (window.confirm(`${result.path} changed outside Studio or already exists. Overwrite it with this workspace?`)) await saveDesktopWorkspace(true, result.path, true);
        return;
      }
      if (!result.document) throw new Error("Desktop did not return the saved workspace metadata.");
      const binding = nativeBinding(result.document);
      workspaceBaselineRef.current = result.document.contents;
      setWorkspaceNativeFile(binding);
      setDocuments(current => current.map(document => document.nativeFile ? document : { ...document, dirty: false }));
      clearExternalChange(binding.path); rememberNative("workspace", binding);
      setNotice({ tone: "good", text: `Saved ${binding.filename} atomically.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
  }

  function saveWorkspaceFile(saveAs = false) {
    if (nativeDocumentsAvailable()) void saveDesktopWorkspace(saveAs);
    else saveBrowserWorkspaceFile();
  }

  function saveRunRecord() {
    const record = activeDocument.lastRun;
    if (!record) { setNotice({ tone: "info", text: "Run at least one code cell before exporting a run record." }); return; }
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    const base = filename.replace(/\.(bln|md)$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "biolang-run";
    anchor.href = url; anchor.download = `${base}.run.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice({ tone: "good", text: `Exported the latest ${record.runtime.runtime} run record with source and input checksums.` });
  }

  function useDesktopKernel() {
    if (!desktopAvailable()) {
      setNotice({ tone: "info", text: "Install or open BioLang Studio Desktop, then reopen this .blw workspace to use native files and streaming I/O." });
      return;
    }
    if (!window.confirm("Desktop mode runs BioLang natively and can access only files you explicitly select. Continue?")) return;
    setKernelKind("desktop"); setUrlDataError("");
  }

  function useSomerKernel() { setRemoteOpen(true); }

  function restoreWorkspace(workspace: PortableWorkspace, binding: NativeDocumentBinding | null) {
    const restored = workspace.notebooks.map(notebook => ({
      id: notebook.id, filename: notebook.filename, cells: parseNotebook(notebook.source),
      lesson: notebook.lesson ? validateManifest(notebook.lesson) : null, validThrough: -1,
      dataReady: notebook.dataReady ?? {}, dirty: false,
    }));
    pendingWorkspaceBaselineRef.current = Boolean(binding);
    workspaceBaselineRef.current = "";
    setWorkspaceNativeFile(binding);
    setWorkspaceName(workspace.name); setDocuments(restored); setWorkspaceAttachments(workspace.attachments);
    setActiveDocumentId(workspace.activeNotebookId); setLastClosed(null); setKernelEpoch(current => current + 1);
    setNotice({ tone: "info", text: `Opened ${workspace.name}. Missing local data must be attached again; verified cached data is reused automatically.` });
  }

  async function openDesktopWorkspace(path?: string, reload = false) {
    if (!reload && (documents.some(document => document.dirty) || workspaceDirty) && !window.confirm("Opening another workspace replaces the current tabs. Continue without saving all changes?")) return;
    if (reload && (documents.some(document => document.dirty) || workspaceDirty) && !window.confirm("Reload this workspace from disk and discard unsaved workspace changes?")) return;
    try {
      const opened = await openNativeDocument("workspace", path);
      if (!opened) return;
      const workspace = migratePortableWorkspace(JSON.parse(opened.contents));
      const binding = nativeBinding(opened);
      restoreWorkspace(workspace, binding); clearExternalChange(binding.path); rememberNative("workspace", binding);
    } catch (error) {
      if (path) setRecentNativeDocuments(forgetRecentNativeDocument(path));
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function openWorkspaceFile(file?: File) {
    if (!file) return;
    if ((documents.some(document => document.dirty) || workspaceDirty) && !window.confirm("Opening another workspace replaces the current tabs. Continue without saving all changes?")) return;
    const workspace = migratePortableWorkspace(JSON.parse(await file.text()));
    restoreWorkspace(workspace, null);
  }

  function openWorkspace() {
    if (nativeDocumentsAvailable()) void openDesktopWorkspace();
    else workspaceInput.current?.click();
  }

  function openRecentDocument(recent: RecentNativeDocument) {
    if (recent.kind === "notebook") void openDesktopNotebook(recent.path);
    else void openDesktopWorkspace(recent.path);
  }

  function changeAttachmentScope(attachment: WorkspaceAttachment) {
    const scope: WorkspaceAttachment["scope"] = attachment.scope.kind === "workspace" ? { kind: "notebook", notebookId: activeDocumentId } : { kind: "workspace" };
    const next = workspaceAttachmentsRef.current.map(item => item.id === attachment.id ? { ...item, scope } : item);
    try { assertUnambiguousMountPaths(next, documents.map(document => document.id)); }
    catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); return; }
    workspaceAttachmentsRef.current = next; setWorkspaceAttachments(next);
    setNotice({ tone: "info", text: `${attachment.path} is now available to ${scope.kind === "workspace" ? "every notebook" : "this notebook only"}.` });
  }

  function removeAttachmentFromWorkspace(attachment: WorkspaceAttachment) {
    const next = workspaceAttachmentsRef.current.filter(item => item.id !== attachment.id);
    workspaceAttachmentsRef.current = next; setWorkspaceAttachments(next);
    fileStoreRef.current.delete(attachment.id); setMissingAttachmentIds(current => { const next = new Set(current); next.delete(attachment.id); return next; }); setKernelEpoch(current => current + 1);
    setNotice({ tone: "info", text: `${attachment.path} was detached. Cached source data was not deleted.` });
  }

  async function prepareReferencedAttachment(attachment: WorkspaceAttachment) {
    if (attachment.source.kind === "local" || attachment.source.kind === "output") {
      if (kernelKind === "desktop") void attachNativeFiles(attachment).catch(error => setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }));
      else { reattachTargetRef.current = attachment; fileInput.current?.click(); }
      return;
    }
    try {
      setNotice({ tone: "info", text: `Preparing ${attachment.path} from its declared source…` });
      if (kernelKind === "desktop" && kernelRef.current?.fetchRemote) {
        const native = await kernelRef.current.fetchRemote({
          url: attachment.source.kind === "dataset" ? attachment.source.dataset.url : attachment.source.url,
          path: attachment.path, mediaType: attachment.mediaType,
          expectedBytes: attachment.source.kind === "dataset" ? attachment.source.dataset.bytes : attachment.source.sourceBytes,
          expectedSha256: attachment.source.kind === "dataset" ? attachment.source.dataset.sha256 : attachment.source.sourceSha256,
        });
        registerNativeReference(native, attachment.source, attachment.scope);
        setNotice({ tone: "good", text: `${attachment.path} was streamed, checksum-verified, and restored natively.` });
        return;
      }
      const file = attachment.source.kind === "dataset"
        ? await prepareDataset(attachment.source.dataset)
        : (await prepareRemoteAttachment({
          url: attachment.source.url, path: attachment.path, mediaType: attachment.mediaType,
          maximumBytes: MAX_BROWSER_DATA_BYTES, expectedBytes: attachment.source.sourceBytes,
          expectedSha256: attachment.source.sourceSha256,
        })).file;
      await registerAttachment(file, attachment.mediaType, attachment.source, attachment.scope);
      setNotice({ tone: "good", text: `${attachment.path} was checksum-verified and restored.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
  }

  async function refreshStorageStatus() {
    try { setLocalStorageStatus(await storageStatus()); } catch { setLocalStorageStatus({ usage: 0, quota: 0, persistent: false }); }
  }

  async function protectLocalStorage() {
    const persistent = await requestPersistentStorage();
    await refreshStorageStatus();
    setNotice({ tone: persistent ? "good" : "info", text: persistent ? "This browser granted persistent storage for Studio." : "The browser kept its normal eviction policy. Export important workspaces as .blw files." });
  }

  async function clearCachedWorkspaceData() {
    if (!window.confirm("Clear cached datasets and local attachment copies? Notebook text and workspace references will remain.")) return;
    await clearContentCache(); fileStoreRef.current.clear(); attachedRef.current.clear();
    setMissingAttachmentIds(new Set(workspaceAttachmentsRef.current.map(attachment => attachment.id)));
    setPreparedRegistryDatasets(new Set());
    setDocuments(current => current.map(document => ({ ...document, validThrough: -1, dataReady: Object.fromEntries(Object.keys(document.dataReady).map(key => [key, false])) })));
    setKernelEpoch(current => current + 1); await refreshStorageStatus();
    setNotice({ tone: "info", text: "Cached data was cleared. Notebook text remains; reattach local files or prepare declared datasets when needed." });
  }

  function addCell(type: Cell["type"]) {
    setCells(current => [...current, { id: crypto.randomUUID(), type, source: type === "code" ? "# BioLang code" : "Write what this step answers.", editing: true, status: "" }]);
  }

  function addStep() {
    const source = '<!-- bl:step title="New step" -->\n\nExplain what this step answers.\n\n```biolang\n# BioLang code\n```\n\nExplain what the result means.\n\n<!-- /bl:step -->';
    setCells(current => [...current, { id: crypto.randomUUID(), type: "markdown", source, editing: true, status: "" }]);
  }

  function finishMarkdownCell(index: number) {
    setCells(current => {
      const cell = current[index];
      if (!cell || cell.type !== "markdown") return current;
      const { editing: _editing, result: _result, ...notebookCell } = cell;
      const expanded = expandMixedMarkdown(notebookCell);
      if (expanded.length === 1 && expanded[0].id === cell.id) return current.map((item, position) => position === index ? { ...item, editing: false } : item);
      needsResetRef.current = true;
      setValidThrough(value => Math.min(value, index - 1));
      const replacement: Cell[] = expanded.map(item => ({ ...item, editing: false, status: "" }));
      return [...current.slice(0, index), ...replacement, ...current.slice(index + 1)];
    });
  }

  function editStep(items: DisplayBlock["items"]) {
    const start = items[0].index;
    const end = items.at(-1)!.index;
    setCollapsedSteps(current => { const next = new Set(current); next.delete(items[0].cell.step!.id); return next; });
    setCells(current => [
      ...current.slice(0, start),
      { id: crypto.randomUUID(), type: "markdown", source: serializeNotebook(current.slice(start, end + 1)), editing: true, status: "" },
      ...current.slice(end + 1),
    ]);
    needsResetRef.current = true;
    setValidThrough(value => Math.min(value, start - 1));
  }

  function renderCell(cell: Cell, index: number) {
    return <article className={`cell cell-${cell.type} ${cell.status ?? ""}`} key={cell.id}>
      <div className="cell-rail">{cell.type === "code" ? <button title="Run this cell and any prerequisites" disabled={running} onClick={() => void runTo(index)}>▶</button> : <span>¶</span>}<small>{index + 1}</small></div>
      <div className="cell-body">
        {cell.type === "markdown" && !cell.editing ? <><button className="markdown-edit-action" onClick={() => updateCell(index, { editing: true })}>Edit</button><div className="prose" onDoubleClick={() => updateCell(index, { editing: true })}><ReactMarkdown remarkPlugins={[remarkGfm]}>{cell.source}</ReactMarkdown></div></> : <textarea aria-label={`${cell.type} cell ${index + 1}`} className={cell.type === "code" ? "code-editor" : "markdown-editor"} value={cell.source} spellCheck={cell.type === "markdown"} onChange={event => updateCell(index, { source: event.target.value })} onBlur={() => cell.type === "markdown" && finishMarkdownCell(index)}/>}
        {cell.type === "code" && <ResultView result={cell.result} />}
      </div>
      <div className="cell-actions"><button title="Move up" disabled={index === 0} onClick={() => { needsResetRef.current = true; setValidThrough(-1); setCells(current => current.map((item, position) => position === index - 1 ? current[index] : position === index ? current[index - 1] : item)); }}>↑</button><button title="Delete" onClick={() => { needsResetRef.current = true; setValidThrough(-1); setCells(current => current.filter((_, position) => position !== index)); }}>×</button></div>
    </article>;
  }

  return <div className={`app-shell ${workspaceView === "registry" ? "registry-mode" : ""}`}>
    <header className="topbar">
      <div className="brand"><img src="./studio-mark.svg" alt=""/><div><strong>BioLang Studio</strong><small>learn · analyse · reproduce</small></div></div>
      <nav className="workspace-tabs" aria-label="Studio workspace">
        <button className={workspaceView === "notebook" ? "active" : ""} onClick={() => navigateWorkspace("notebook")}>Notebook</button>
        <button className={workspaceView === "registry" ? "active" : ""} onClick={() => navigateWorkspace("registry")}>Registry</button>
      </nav>
      <nav className="toolbar">
        {workspaceView === "notebook" ? <><button onClick={newNotebook}>New</button><button onClick={openFile}>Open</button><button onClick={saveFile}>Save</button>{nativeDocumentsAvailable() && <button onClick={() => void saveDesktopNotebook(true)}>Save as…</button>}<details className="workspace-file-menu"><summary>Workspace{workspaceDirty ? " ●" : ""}</summary><div><button onClick={event => { openWorkspace(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Open .blw</button><button onClick={event => { saveWorkspaceFile(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{nativeDocumentsAvailable() ? "Save .blw" : "Export .blw"}</button>{nativeDocumentsAvailable() && <button onClick={event => { saveWorkspaceFile(true); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Save .blw as…</button>}<button disabled={!activeDocument.lastRun} onClick={event => { saveRunRecord(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Export latest run record</button>{recentNativeDocuments.length > 0 && <div className="recent-native"><small>Recent Desktop files</small>{recentNativeDocuments.map(recent => <button key={recent.path} title={recent.path} onClick={event => { openRecentDocument(recent); event.currentTarget.closest("details")?.removeAttribute("open"); }}><span>{recent.filename}</span><em>{recent.kind}</em></button>)}</div>}</div></details>
          <button className="primary" disabled={running || codeCount === 0} onClick={() => void runTo(cells.length - 1, true)}>▶ Run all</button>
          {running && <button onClick={() => void stopRun()}>Stop</button>}</> : <button onClick={() => void refreshRegistry()}>Refresh registry</button>}
      </nav>
      <div className="kernel-switch">
        <label>Kernel<select value={kernelKind} disabled={running} onChange={event => {
          const next = event.target.value as KernelKind;
          if (next === "somer") { setRemoteOpen(true); return; }
          if (next === "desktop") { event.currentTarget.value = kernelKind; useDesktopKernel(); return; }
          setKernelKind(next);
        }}>
          <option value="browser">Browser WASM</option>{desktopAvailable() && <option value="desktop">Desktop</option>}<option value="somer">SOMER remote…</option>
        </select></label><span className={`status status-${kernelState}`}>{kernelState}</span>
      </div>
    </header>
    {workspaceView === "notebook" && <aside className="sidebar">
      <section className="discover"><div className="section-head"><h2>Discover</h2><button title="Refresh registry" onClick={() => void refreshRegistry()}>↻</button></div>
        <div className="discover-summary"><strong>{registrySource === "loading" ? "Checking registry…" : registrySource === "unavailable" ? "Registry unavailable" : `${registryEntries.length} registered item${registryEntries.length === 1 ? "" : "s"}`}</strong><span>{registrySource === "cache" ? "Using the verified offline cache." : "Browse lessons, datasets, workflows and tools."}</span><button onClick={() => navigateWorkspace("registry")}>Browse registry</button></div>
      </section>
      <section><div className="section-head"><h2>Installed lessons</h2><button title="Add lesson package" onClick={() => setPackageOpen(true)}>＋</button></div>{catalog.length ? catalog.map(item => <div className={`lesson-row ${lesson?.id === item.id ? "active" : ""}`} key={item.id}><button className="lesson-link" onClick={() => void loadLesson(item)}><strong>{item.title}</strong><span>{item.summary}</span></button><button className="remove-package" title={`Remove ${item.title}`} onClick={() => void removePackage(item)}>×</button></div>) : <div className="empty-catalog"><p>No lesson packages installed.</p><button onClick={() => setPackageOpen(true)}>Add from manifest URL</button></div>}</section>
      <section><h2>Data</h2>{lesson ? lesson.datasets.map(dataset => <div className="dataset" key={dataset.id}><div><strong>{dataset.title}</strong><span>{displayBytes(dataset.bytes)} · verified download</span></div><button disabled={dataReady[dataset.id]} onClick={() => void prepare(dataset.id)}>{dataReady[dataset.id] ? "Ready" : progress[dataset.id] ? `${Math.round(progress[dataset.id] / dataset.bytes * 100)}%` : "Prepare"}</button></div>) : <p className="muted">A lesson can declare the exact data it needs.</p>}
        {visibleAttachments.map(attachment => <div className={`attached-data ${missingAttachmentIds.has(attachment.id) ? "missing" : ""}`} key={attachment.id}><div><strong>{attachment.path}</strong><span title={attachment.source.kind === "url" ? attachment.source.url : attachment.source.kind === "output" ? `Published from ${attachment.source.producerNotebookFilename}: ${attachment.source.variable}` : undefined}>{missingAttachmentIds.has(attachment.id) ? "needs data · " : `${displayBytes(attachment.size)} · `}{attachment.scope.kind === "workspace" ? "all notebooks" : "this notebook"}{attachment.source.kind === "url" ? " · HTTPS source" : attachment.source.kind === "output" ? ` · output from ${attachment.source.producerNotebookFilename}` : ""}</span></div>{missingAttachmentIds.has(attachment.id) && <button onClick={() => void prepareReferencedAttachment(attachment)}>{attachment.source.kind === "local" || attachment.source.kind === "output" ? "Reattach" : "Prepare"}</button>}<button onClick={() => changeAttachmentScope(attachment)}>{attachment.scope.kind === "workspace" ? "Keep here" : "Share"}</button><button aria-label={`Detach ${attachment.path}`} title="Detach without deleting cached source data" onClick={() => removeAttachmentFromWorkspace(attachment)}>×</button></div>)}
        <div className="data-actions"><button onClick={() => {
          if (kernelKind === "desktop") void attachNativeFiles().catch(error => setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }));
          else { reattachTargetRef.current = null; fileInput.current?.click(); }
        }}>Attach local</button><button onClick={() => { setUrlDataReview(false); setUrlDataError(""); setUrlDataOpen(true); }}>From URL…</button></div>
        {kernelKind === "browser" && <details className="runtime-handoff"><summary>Need larger or protected data?</summary><p>Keep the notebook and move only its execution when browser limits are unsuitable.</p><div>{desktopAvailable() && <button onClick={useDesktopKernel}>Use Desktop</button>}<button onClick={useSomerKernel}>Use SOMER…</button></div></details>}
      </section>
      <section className="variables-section"><VariableInspector variables={variables} revision={variableRevision} canInspect={kernelRef.current?.capabilities.variableInspection ?? false} exportMode={kernelRef.current?.capabilities.variableExport ?? "none"} canRemove={kernelRef.current?.capabilities.variableRemoval ?? false} inspect={(name, offset, limit) => kernelRef.current!.inspectVariable(name, offset, limit)} exportExact={(name, format, maximumBytes) => kernelRef.current!.exportVariable(name, format, maximumBytes)} publishOutput={publishWorkspaceOutput} notify={setNotice}/></section>
      <section className="storage-section"><details className={`storage-disclosure ${localStorageStatus.quota && localStorageStatus.usage / localStorageStatus.quota >= .8 ? "warning" : ""}`}><summary><span>Local storage</span><small>{displayBytes(localStorageStatus.usage)}</small></summary><div className="storage-meter" role="meter" aria-label="Browser storage used" aria-valuemin={0} aria-valuemax={localStorageStatus.quota || 1} aria-valuenow={localStorageStatus.usage}><i style={{ width: `${localStorageStatus.quota ? Math.min(100, localStorageStatus.usage / localStorageStatus.quota * 100) : 0}%` }}/></div><p className="muted">{displayBytes(localStorageStatus.usage)} used{localStorageStatus.quota ? ` of ${displayBytes(localStorageStatus.quota)}` : ""} · {localStorageStatus.persistent ? "protected from automatic eviction" : "browser-managed"}</p><div><button onClick={() => void refreshStorageStatus()}>Refresh</button>{!localStorageStatus.persistent && <button onClick={() => void protectLocalStorage()}>Protect</button>}<button className="danger" onClick={() => void clearCachedWorkspaceData()}>Clear cached data</button></div></details></section>
    </aside>}
    {workspaceView === "notebook" ? <main>
      <div className="document-tabs"><input aria-label="Workspace name" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} /><div role="tablist" aria-label="Open notebooks">{documents.map(document => <div className={`document-tab ${document.id === activeDocumentId ? "active" : ""}`} key={document.id}><button role="tab" aria-selected={document.id === activeDocumentId} onClick={() => switchNotebook(document.id)}><span>{document.filename}</span>{document.dirty && <i title="Unsaved changes">●</i>}</button><button aria-label={`Close ${document.filename}`} onClick={() => closeNotebook(document.id)}>×</button></div>)}</div><button title="New notebook" aria-label="New notebook" onClick={newNotebook}>＋</button>{lastClosed && <button className="reopen-tab" onClick={reopenNotebook}>Reopen closed</button>}</div>
      <div className="document-head"><div><input aria-label="Notebook name" value={filename} onChange={event => setFilename(event.target.value)} /><span>{cells.length} cells · {codeCount} runnable</span></div>{lesson && <a href={lesson.source.url} target="_blank" rel="noreferrer">Inspired by {lesson.source.title} ↗</a>}</div>
      {notice && <div className={`notice notice-${notice.tone}`}>{notice.text}</div>}
      {(notebookChangedExternally || workspaceChangedExternally) && <div className="external-change" role="alert"><div><strong>Changed outside Studio</strong><span>Reload the disk version, or Save and explicitly confirm an overwrite.</span></div>{notebookChangedExternally && activeDocument.nativeFile && <button onClick={() => void openDesktopNotebook(activeDocument.nativeFile!.path, true)}>Reload notebook</button>}{workspaceChangedExternally && workspaceNativeFile && <button onClick={() => void openDesktopWorkspace(workspaceNativeFile.path, true)}>Reload workspace</button>}</div>}
      <div className="cells">{displayBlocks.map(block => block.step ? <section className={`lesson-step ${collapsedSteps.has(block.step.id) ? "collapsed" : ""}`} key={block.key}>
        <header className="lesson-step-head"><div><span>Lesson step</span><strong>{block.step.title || "Untitled step"}</strong><small>{block.items.filter(item => item.cell.type === "code").length} runnable</small></div><div><button disabled={running || !block.items.some(item => item.cell.type === "code")} onClick={() => void runTo(block.items.at(-1)!.index)}>▶ Run step</button><button onClick={() => editStep(block.items)}>Edit source</button><button aria-label={`${collapsedSteps.has(block.step.id) ? "Expand" : "Collapse"} ${block.step.title || "lesson step"}`} onClick={() => setCollapsedSteps(current => { const next = new Set(current); if (next.has(block.step!.id)) next.delete(block.step!.id); else next.add(block.step!.id); return next; })}>{collapsedSteps.has(block.step.id) ? "▸" : "▾"}</button></div></header>
        {!collapsedSteps.has(block.step.id) && <div className="lesson-step-cells">{block.items.map(({ cell, index }) => renderCell(cell, index))}</div>}
      </section> : block.items.map(({ cell, index }) => renderCell(cell, index)))}</div>
      <div className="add-cells"><button onClick={() => addCell("code")}>+ Code</button><button onClick={() => addCell("markdown")}>+ Explanation</button><button onClick={addStep}>+ Step</button></div>
    </main> : <RegistryWorkspace entries={registryEntries} source={registrySource} error={registryError} filters={registryFilters} selectedKey={selectedRegistryKey} installedLessons={installedLessonNames} preparedDatasets={preparedRegistryDatasets} installingId={installingId} datasetDetails={registryDatasetDetails} detailLoading={registryDetailLoading} detailError={registryDetailError} notice={notice} onFiltersChange={updateRegistryFilters} onSelect={selectRegistryEntry} onRefresh={() => void refreshRegistry()} onInstall={entry => void installRegistryEntry(entry)} onOpenLesson={entry => void openRegistryLesson(entry)} onPrepare={(entry, details) => void prepareRegistryDataset(entry, details)} onCopyCommand={entry => void copyRegistryCommand(entry)}/>}
    <input hidden ref={fileInput} type="file" multiple onChange={event => { const input = event.currentTarget; void attachFiles(input.files).catch(error => setNotice({ tone: "bad", text: error.message })).finally(() => { input.value = ""; }); }}/>
    <input hidden ref={notebookInput} type="file" accept=".bln,.md,.bl.md" onChange={event => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; void openBrowserFile(file); }}/>
    <input hidden ref={workspaceInput} type="file" accept=".blw,application/json" onChange={event => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; void openWorkspaceFile(file).catch(error => setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) })); }}/>
    {remoteOpen && <div className="modal-backdrop"><form className="modal" onSubmit={event => { event.preventDefault(); setKernelKind("somer"); setRemoteOpen(false); }}><h2>Connect to SOMER</h2><p>The token stays in memory and is never saved by Studio.</p><label>Server URL<input required type="url" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://compute.example.org" /></label><label>Bearer token<input required type="password" value={remoteToken} onChange={event => setRemoteToken(event.target.value)} /></label><div><button type="button" onClick={() => setRemoteOpen(false)}>Cancel</button><button className="primary" type="submit">Connect</button></div></form></div>}
    {packageOpen && <div className="modal-backdrop"><form className="modal" onSubmit={event => { event.preventDefault(); void addPackage(); }}><h2>Add a lesson package</h2><p>Paste an HTTPS URL to a BioLang Studio lesson manifest. Custom manifests are validated but do not carry the registry's manifest checksum. Declared datasets are downloaded separately only when you choose Prepare.</p><label>Manifest URL<input required type="url" value={packageUrl} onChange={event => setPackageUrl(event.target.value)} placeholder="https://example.org/lesson.json" /></label><div><button type="button" onClick={() => setPackageOpen(false)}>Cancel</button><button className="primary" type="submit">Add lesson</button></div></form></div>}
    {urlDataOpen && <div className="modal-backdrop"><form className="modal url-data-modal" onSubmit={event => { event.preventDefault(); if (urlDataReview) void downloadUrlData(); else reviewUrlData(); }}>
      <h2>{urlDataReview ? "Review remote data" : "Add data from URL"}</h2>
      {urlDataError && <p className="url-data-error" role="alert">{urlDataError}</p>}
      {!urlDataReview ? <>
        <p>Studio downloads only after review. The URL and observed checksum are saved as workspace provenance. Do not use secret or credential-bearing URLs.</p>
        <label>HTTPS source URL<input required type="url" value={urlDataDraft.url} onChange={event => setUrlDataDraft(current => {
          const previousSuggested = suggestedRemotePath(current.url); const path = !current.path || current.path === previousSuggested ? suggestedRemotePath(event.target.value) : current.path;
          const mediaType = current.mediaType === inferredMediaType(current.path) ? inferredMediaType(path) : current.mediaType;
          return { ...current, url: event.target.value, path, mediaType };
        })} placeholder="https://data.example.org/measurements.csv" /></label>
        <label>Mount path<input required value={urlDataDraft.path} onChange={event => setUrlDataDraft(current => {
          const mediaType = current.mediaType === inferredMediaType(current.path) ? inferredMediaType(event.target.value) : current.mediaType;
          return { ...current, path: event.target.value, mediaType };
        })} placeholder="measurements.csv" /></label>
        <label>File type<select value={urlDataDraft.mediaType} onChange={event => setUrlDataDraft(current => ({ ...current, mediaType: event.target.value }))}><option value="text/csv">CSV</option><option value="text/tab-separated-values">TSV</option><option value="application/json">JSON / JSON Lines</option><option value="text/plain">Plain text</option><option value="application/octet-stream">UTF-8 text with unknown server type</option></select></label>
        <label>Expected bytes <span>(optional)</span><input type="number" min="0" max={kernelKind === "desktop" ? MAX_NATIVE_DATA_BYTES : MAX_BROWSER_DATA_BYTES} step="1" value={urlDataDraft.expectedBytes} onChange={event => setUrlDataDraft(current => ({ ...current, expectedBytes: event.target.value }))} placeholder={`Unknown — hard stop at ${displayBytes(kernelKind === "desktop" ? MAX_NATIVE_DATA_BYTES : MAX_BROWSER_DATA_BYTES)}`} /></label>
        <label>Expected SHA-256 <span>(recommended when published)</span><input value={urlDataDraft.expectedSha256} onChange={event => setUrlDataDraft(current => ({ ...current, expectedSha256: event.target.value }))} minLength={64} maxLength={64} pattern="[A-Fa-f0-9]{64}" placeholder="64 hexadecimal characters" /></label>
        <label className="check-label"><input type="checkbox" checked={urlDataDraft.shared} onChange={event => setUrlDataDraft(current => ({ ...current, shared: event.target.checked }))} />Share with every notebook in this workspace</label>
        <p className="modal-guidance">{kernelKind === "desktop" ? `Desktop streams public HTTPS data directly to this notebook's private directory, accepts binary formats, and stops at ${displayBytes(MAX_NATIVE_DATA_BYTES)}.` : `The source must permit browser CORS. Browser Studio accepts UTF-8 text only and stops at ${displayBytes(MAX_BROWSER_DATA_BYTES)}. Use Desktop or SOMER for larger or binary data.`}</p>
        {kernelKind === "browser" && <div className="modal-handoff">{desktopAvailable() && <button type="button" onClick={useDesktopKernel}>Switch to Desktop</button>}<button type="button" onClick={() => { closeUrlData(); useSomerKernel(); }}>Connect to SOMER…</button></div>}
      </> : <>
        <p>Confirm what Studio will request and preserve before any file bytes are downloaded.</p>
        <dl className="url-review"><div><dt>Source</dt><dd>{urlDataDraft.url}</dd></div><div><dt>Mount as</dt><dd>{urlDataDraft.path}</dd></div><div><dt>Type</dt><dd>{urlDataDraft.mediaType}</dd></div><div><dt>Expected size</dt><dd>{urlDataDraft.expectedBytes ? displayBytes(Number(urlDataDraft.expectedBytes)) : `Unknown — stop at ${displayBytes(kernelKind === "desktop" ? MAX_NATIVE_DATA_BYTES : MAX_BROWSER_DATA_BYTES)}`}</dd></div><div><dt>Integrity</dt><dd>{urlDataDraft.expectedSha256 || "No published checksum supplied; Studio will record the observed SHA-256"}</dd></div><div><dt>Scope</dt><dd>{urlDataDraft.shared ? "All notebooks" : "This notebook only"}</dd></div></dl>
        {urlDataDownloading && <p className="download-progress">{kernelKind === "desktop" ? "Streaming directly to the private native data directory…" : <>Downloaded {displayBytes(urlDataProgress)}{urlDataDraft.expectedBytes ? ` of ${displayBytes(Number(urlDataDraft.expectedBytes))}` : ""}…</>}</p>}
      </>}
      <div><button type="button" disabled={urlDataDownloading} onClick={urlDataReview ? () => { setUrlDataReview(false); setUrlDataError(""); } : closeUrlData}>{urlDataReview ? "Change" : "Cancel"}</button>{urlDataReview && <button type="button" disabled={urlDataDownloading} onClick={closeUrlData}>Cancel</button>}<button className="primary" disabled={urlDataDownloading} type="submit">{urlDataReview ? urlDataDownloading ? "Downloading…" : "Download and attach" : "Review"}</button></div>
    </form></div>}
  </div>;
}
