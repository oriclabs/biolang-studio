import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CatalogEntry, DatasetManifest, LessonManifest } from "./content/manifest";
import { lessonEntryForDocument, manifestLessonEntries, validateManifest } from "./content/manifest";
import { isLoopbackUrl } from "./content/url-policy";
import { installLesson, installedLessons, lessonUpdateAvailable, uninstallLesson } from "./content/installed";
import { manifestLessonShareUrl, parseLessonLaunchUrl, registryLessonShareUrl, removeLessonLaunchParams, type LessonLaunchRequest } from "./content/lesson-links";
import { fetchRegisteredDataset, fetchRegistry, latestRegistryEntry, publicRegistryUrl, type RegisteredDatasetManifest, type RegistryEntry, type RegistryKindFilter, type RegistrySource } from "./content/registry";
import type { AttachedFile, ExecutionResult, Kernel, KernelKind, NativeFileReference, RuntimeInfo, StructuredResult, VariableExportFormat, VariableSummary } from "./kernel/protocol";
import { DesktopKernel, desktopAvailable } from "./kernel/desktop-client";
import { SomerKernel } from "./kernel/somer-client";
import { WasmKernel } from "./kernel/wasm-client";
import { forgetRecentNativeDocument, nativeDocumentStatus, nativeDocumentsAvailable, openNativeDocument, readRecentNativeDocuments, rememberNativeDocument, saveNativeDocument, type NativeDocumentBinding, type NativeDocumentKind, type RecentNativeDocument } from "./kernel/native-documents";
import { directives, executableSource, expandMixedMarkdown, parseNotebook, serializeNotebook, type NotebookCell } from "./notebook/format";
import { compileNotebookCode, readNotebookCodeLanguage, saveNotebookCodeLanguage, type NotebookCodeLanguage } from "./notebook/language";
import { cacheAttachment, clearContentCache, hasDataset, loadAttachment, loadWorkspaceSession, prepareDataset, prepareRemoteAttachment, removeDataset, requestPersistentStorage, saveWorkspaceSession, sha256, storageStatus, type StorageStatus } from "./storage/content-store";
import { RegistryWorkspace, type RegistryViewState } from "./registry/RegistryWorkspace";
import { assertUnambiguousMountPaths, attachmentId, isSafeWorkspacePath, migratePortableWorkspace, WORKSPACE_SCHEMA_URL, type PortableWorkspace, type WorkspaceAttachment } from "./workspace/format";
import { VariableInspector } from "./VariableInspector";
import { StatisticsGuideDialog } from "./StatisticsGuideDialog";
import { PlotView } from "./PlotView";
import { ExportNotebookDialog } from "./ExportNotebookDialog";
import { DialogShell } from "./DialogShell";
import { LessonLaunchDialog, type LessonLaunchReview } from "./LessonLaunchDialog";
import { LessonUpdateDialog } from "./LessonUpdateDialog";
import { reportIssues, type NotebookReport, type ReportFormat, type ReportOptions } from "./export/model";
import { markdownComponents } from "./markdown-components";
import { applyStudioTheme, readStudioTheme, saveStudioTheme, type StudioTheme } from "./theme";
import { CodeEditor } from "./CodeEditor";

type Cell = NotebookCell & { result?: ExecutionResult; editing?: boolean };
type JavaScriptTranslation = { biolangSource: string; javascriptSource?: string; error?: string; edited?: boolean };
type Notice = { tone: "info" | "good" | "bad"; text: string; id?: string } | null;
const MARKDOWN_COMPONENTS = markdownComponents();
const INITIAL_NOTICE: NonNullable<Notice> = { id: "welcome", tone: "info", text: "Run any code cell; required earlier cells run automatically." };
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
  notebook: { id: string; filename: string; sourceLanguage: NotebookCodeLanguage; sourceSha256: string; frontendSourceSha256: string; executedSourceSha256: string; executedThrough: number; codeCells: number };
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
  lessonManifestSha256?: string;
  validThrough: number;
  dataReady: Record<string, boolean>;
  dirty: boolean;
  lastRun?: RunRecord;
  nativeFile?: NativeDocumentBinding;
};
type DocumentTabGroup = {
  key: string;
  label: string;
  documents: NotebookDocument[];
  collection: boolean;
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

function createNotebook(filename = "untitled.bln", source = SAMPLE, lesson: LessonManifest | null = null, lessonManifestSha256?: string): NotebookDocument {
  return { id: crypto.randomUUID(), filename, cells: parseNotebook(source), lesson, lessonManifestSha256, validThrough: -1, dataReady: {}, dirty: false };
}

function collectionKey(document: NotebookDocument) {
  return document.lesson?.schema === 2
    ? `lesson:${document.lesson.id}:${document.lessonManifestSha256 ?? "local"}`
    : `notebook:${document.id}`;
}

function groupDocumentTabs(documents: NotebookDocument[]): DocumentTabGroup[] {
  const groups: DocumentTabGroup[] = [];
  for (const document of documents) {
    const key = collectionKey(document);
    const existing = groups.find(group => group.key === key);
    if (existing) existing.documents.push(document);
    else groups.push({
      key,
      label: document.lesson?.schema === 2 ? document.lesson.title : document.filename,
      documents: [document],
      collection: document.lesson?.schema === 2,
    });
  }
  return groups;
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
      access: (kind === "dataset" && ["public", "registration", "controlled"].includes(params.get("access") ?? "") ? params.get("access") : "all") as RegistryViewState["access"],
      verification: ((params.get("trust") === "preview" ? "unverified" : ["verified", "unverified"].includes(params.get("trust") ?? "") ? params.get("trust") : "all")) as RegistryViewState["verification"],
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

function lessonLaunchFromLocation(): { request: LessonLaunchRequest | null; error: string } {
  try { return { request: parseLessonLaunchUrl(location.href), error: "" }; }
  catch (error) { return { request: null, error: error instanceof Error ? error.message : String(error) }; }
}

async function inspectLessonManifest(rawUrl: string, baseUrl: string, expectedHash?: string, expectedId?: string, signal?: AbortSignal) {
  const parsedUrl = new URL(rawUrl, baseUrl);
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && isLoopbackUrl(parsedUrl))) throw new Error("Lesson manifests must use HTTPS (HTTP loopback URLs are allowed for local development).");
  const response = await fetch(parsedUrl.href, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache", signal });
  if (!response.ok) throw new Error(`Lesson manifest returned HTTP ${response.status}.`);
  const manifestText = await response.text();
  const observedSha256 = await sha256(manifestText);
  if (expectedHash && observedSha256.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("The lesson manifest failed its shared or registry SHA-256 check.");
  let decoded: unknown;
  try { decoded = JSON.parse(manifestText); }
  catch { throw new Error("Lesson manifest is not valid JSON."); }
  const manifest = validateManifest(decoded, { allowLoopback: isLoopbackUrl(parsedUrl) });
  if (expectedId && manifest.id !== expectedId) throw new Error(`The lesson link expected '${expectedId}', but the manifest identifies '${manifest.id}'.`);
  return { manifest, manifestUrl: parsedUrl.href, observedSha256 };
}

const ResultView = memo(function ResultView({ result }: { result?: ExecutionResult }) {
  if (!result) return null;
  return <div className={`result ${result.ok ? "result-ok" : "result-error"}`} role={result.ok ? undefined : "alert"}>
    <div className="result-meta"><span>{result.backend ?? "kernel"}</span><span>{result.elapsedMs ?? 0} ms</span></div>
    {result.output && <pre className="stdout">{result.output}</pre>}
    {!result.ok && <pre className="error-text">{result.error}</pre>}
    {result.ok && result.results?.map((item, index) => <StructuredView key={index} result={item} />)}
    {result.ok && !result.results?.length && result.value && result.value !== "Nil" && <pre>{result.value}</pre>}
  </div>;
});

const MarkdownView = memo(function MarkdownView({ source, index, edit }: { source: string; index: number; edit: (index: number) => void }) {
  return <div className="prose" onDoubleClick={() => edit(index)}><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{source}</ReactMarkdown></div>;
});

const AutoGrowTextarea = memo(function AutoGrowTextarea({ label, className, value, spellCheck, change, blur, run }: {
  label: string; className: string; value: string; spellCheck: boolean; change: (value: string) => void; blur?: () => void; run?: (advance: boolean) => void;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(90, element.scrollHeight)}px`;
  }, [value]);
  return <textarea ref={editor} aria-label={label} className={className} value={value} spellCheck={spellCheck} onChange={event => change(event.target.value)} onBlur={blur} onKeyDown={event => {
    if (run && event.key === "Enter" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault(); run(event.shiftKey); return;
    }
    if (className === "code-editor" && event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart; const end = target.selectionEnd;
      const insertion = "  ";
      change(`${value.slice(0, start)}${insertion}${value.slice(end)}`);
      requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + insertion.length; });
    }
  }}/>;
}, (previous, next) => previous.label === next.label && previous.className === next.className && previous.value === next.value && previous.spellCheck === next.spellCheck);

function readableValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ValueTable({ value }: { value: unknown }) {
  const [limit, setLimit] = useState(100);
  useEffect(() => setLimit(100), [value]);
  if (Array.isArray(value)) {
    const records = value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>;
    if (records.length === value.length && records.length > 0) {
      const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
      return <div className="table-wrap"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{records.slice(0, limit).map((record, row) => <tr key={row}>{columns.map(column => <td key={column}>{readableValue(record[column])}</td>)}</tr>)}</tbody></table>{records.length > limit && <p>Showing {limit} of {records.length} rows. <button onClick={() => setLimit(current => Math.min(records.length, current + 100))}>Show 100 more</button></p>}</div>;
    }
    return <div className="table-wrap"><table><thead><tr><th>#</th><th>Value</th></tr></thead><tbody>{value.slice(0, limit).map((item, index) => <tr key={index}><td>{index + 1}</td><td>{readableValue(item)}</td></tr>)}</tbody></table>{value.length > limit && <p>Showing {limit} of {value.length} values. <button onClick={() => setLimit(current => Math.min(value.length, current + 100))}>Show 100 more</button></p>}</div>;
  }
  if (value && typeof value === "object") {
    return <div className="table-wrap key-value-table"><table><thead><tr><th>Measure</th><th>Value</th></tr></thead><tbody>{Object.entries(value).map(([key, item]) => <tr key={key}><th scope="row">{key.replaceAll("_", " ")}</th><td>{readableValue(item)}</td></tr>)}</tbody></table></div>;
  }
  return <pre>{readableValue(value)}</pre>;
}

function StructuredView({ result }: { result: StructuredResult }) {
  const [view, setView] = useState<"table" | "json">("table");
  const markup = typeof result.data === "string" ? result.data : typeof result.value === "string" ? result.value : "";
  if ((result.kind === "plot" || result.format === "svg") && markup.includes("<svg")) {
    return <PlotView markup={markup} />;
  }
  const tabularValue = result.columns && result.rows
    ? result.rows.map(row => Object.fromEntries(result.columns!.map((column, index) => [column, row[index]])))
    : result.value ?? result;
  const structured = tabularValue !== null && typeof tabularValue === "object";
  if (!structured) return <pre>{readableValue(tabularValue)}</pre>;
  return <div className="structured-output">
    <div className="result-view-switch" aria-label="Result format"><button className={view === "table" ? "active" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button><button className={view === "json" ? "active" : ""} aria-pressed={view === "json"} onClick={() => setView("json")}>JSON</button></div>
    {view === "table" ? <ValueTable value={tabularValue} /> : <pre>{JSON.stringify(tabularValue, null, 2)}</pre>}
    {view === "table" && result.truncated && <p className="result-preview-note">Showing a preview of {result.totalRows ?? "many"} rows.</p>}
  </div>;
}

export default function App() {
  const initialRegistryState = useRef(registryStateFromUrl()).current;
  const initialLessonLaunch = useRef(lessonLaunchFromLocation()).current;
  const kernelRef = useRef<Kernel | null>(null);
  const attachedRef = useRef(new Map<string, AttachedFile>());
  const fileStoreRef = useRef(new Map<string, AttachedFile>());
  const needsResetRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const runAfterPrepareRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const notebookInput = useRef<HTMLInputElement>(null);
  const workspaceInput = useRef<HTMLInputElement>(null);
  const reattachTargetRef = useRef<WorkspaceAttachment | null>(null);
  const collectionSelectionRef = useRef<Record<string, string>>({});
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
  const [lessonInfo, setLessonInfo] = useState<CatalogEntry | null>(null);
  const [kernelKind, setKernelKind] = useState<KernelKind>("browser");
  const [kernelState, setKernelState] = useState("starting");
  const [colorTheme, setColorTheme] = useState<StudioTheme>(readStudioTheme);
  const [codeLanguage, setCodeLanguage] = useState<NotebookCodeLanguage>(readNotebookCodeLanguage);
  const [javascriptTranslations, setJavascriptTranslations] = useState<Record<string, JavaScriptTranslation>>({});
  const [kernelEpoch, setKernelEpoch] = useState(0);
  const [running, setRunning] = useState(false);
  const [notice, setNoticeState] = useState<Notice>(INITIAL_NOTICE);
  const setNotice = useCallback((next: Notice) => setNoticeState(current => current?.tone === "bad" && next?.tone === "info" ? current : next), []);
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
  const [statisticsGuideOpen, setStatisticsGuideOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [packageUrl, setPackageUrl] = useState("");
  const [lessonLaunchRequest, setLessonLaunchRequest] = useState<LessonLaunchRequest | null>(initialLessonLaunch.request);
  const [lessonLaunchReview, setLessonLaunchReview] = useState<LessonLaunchReview | null>(null);
  const [lessonLaunchLoading, setLessonLaunchLoading] = useState(Boolean(initialLessonLaunch.request));
  const [lessonLaunchError, setLessonLaunchError] = useState(initialLessonLaunch.error);
  const [lessonLaunchBusy, setLessonLaunchBusy] = useState(false);
  const [pendingLaunchRunId, setPendingLaunchRunId] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(initialRegistryState.view);
  const [registryEntries, setRegistryEntries] = useState<RegistryEntry[]>([]);
  const [registrySource, setRegistrySource] = useState<RegistrySource | "loading" | "unavailable">("loading");
  const [registryCheckedAt, setRegistryCheckedAt] = useState("");
  const [registryError, setRegistryError] = useState("");
  const [installingId, setInstallingId] = useState("");
  const [lessonUpdateEntry, setLessonUpdateEntry] = useState<RegistryEntry | null>(null);
  const [registryFilters, setRegistryFilters] = useState<RegistryViewState>(initialRegistryState.filters);
  const [selectedRegistryKey, setSelectedRegistryKey] = useState(initialRegistryState.entry);
  const [registryDatasetDetails, setRegistryDatasetDetails] = useState<RegisteredDatasetManifest | null>(null);
  const [registryDetailLoading, setRegistryDetailLoading] = useState(false);
  const [registryDetailError, setRegistryDetailError] = useState("");
  const [preparedRegistryDatasets, setPreparedRegistryDatasets] = useState<Set<string>>(() => new Set());
  const activeDocument = documents.find(document => document.id === activeDocumentId) ?? documents[0];
  const { cells, lesson, filename, validThrough, dataReady } = activeDocument;
  const documentTabGroups = useMemo(() => groupDocumentTabs(documents), [documents]);
  const activeCollectionEntries = useMemo(() => lesson?.schema === 2 ? manifestLessonEntries(lesson) : [], [lesson]);
  const activeCollectionEntry = lesson?.schema === 2 ? lessonEntryForDocument(lesson, filename) : undefined;
  const activeCollectionIndex = activeCollectionEntry ? activeCollectionEntries.findIndex(entry => entry.id === activeCollectionEntry.id) : -1;
  const visibleAttachments = useMemo(() => workspaceAttachments.filter(attachment => attachment.scope.kind === "workspace" || attachment.scope.notebookId === activeDocumentId), [workspaceAttachments, activeDocumentId]);
  const visibleUserAttachments = useMemo(() => visibleAttachments.filter(attachment => {
    if (attachment.source.kind !== "dataset") return true;
    const datasetId = attachment.source.dataset.id;
    return !lesson?.datasets.some(dataset => dataset.id === datasetId);
  }), [visibleAttachments, lesson]);
  const currentWorkspaceText = useMemo(() => JSON.stringify(makePortableWorkspace(), null, 2), [documents, activeDocumentId, workspaceAttachments, workspaceName]);
  const workspaceDirty = Boolean(workspaceNativeFile && workspaceBaselineRef.current && workspaceBaselineRef.current !== currentWorkspaceText);
  const notebookChangedExternally = Boolean(activeDocument.nativeFile && externallyChangedPaths.has(activeDocument.nativeFile.path));
  const workspaceChangedExternally = Boolean(workspaceNativeFile && externallyChangedPaths.has(workspaceNativeFile.path));

  useEffect(() => {
    if (activeDocument.lesson?.schema === 2) collectionSelectionRef.current[collectionKey(activeDocument)] = activeDocument.id;
  }, [activeDocument]);

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
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => applyStudioTheme(colorTheme, preference.matches);
    saveStudioTheme(colorTheme);
    syncTheme();
    if (colorTheme === "system") preference.addEventListener("change", syncTheme);
    return () => preference.removeEventListener("change", syncTheme);
  }, [colorTheme]);

  useEffect(() => saveNotebookCodeLanguage(codeLanguage), [codeLanguage]);

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
        lessonManifestSha256: notebook.lessonManifestSha256,
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
    if (kernelState !== "ready") return;
    let alive = true;
    const pending = cells.filter(cell => cell.type === "code").filter(cell => javascriptTranslations[cell.id]?.biolangSource !== executableSource(cell.source));
    if (!pending.length) return;
    void Promise.all(pending.map(async cell => {
      const biolangSource = executableSource(cell.source);
      if (cell.javascriptSource) return [cell.id, { biolangSource, javascriptSource: cell.javascriptSource, edited: true }] as const;
      if (!kernelRef.current?.transpileJavaScript) return [cell.id, { biolangSource, error: "Switch to the Browser kernel to generate this JavaScript view." }] as const;
      try { return [cell.id, { biolangSource, javascriptSource: await kernelRef.current!.transpileJavaScript!(biolangSource) }] as const; }
      catch (error) { return [cell.id, { biolangSource, error: error instanceof Error ? error.message : String(error) }] as const; }
    })).then(entries => alive && setJavascriptTranslations(current => ({ ...current, ...Object.fromEntries(entries) })));
    return () => { alive = false; };
  }, [cells, kernelState, kernelKind, javascriptTranslations]);

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
  const currentCodeCount = useMemo(() => cells.filter(cell => cell.type === "code" && (cell.status === "done" || cell.status === "skipped")).length, [cells]);
  const displayBlocks = useMemo(() => groupNotebookCells(cells), [cells]);
  const pendingLessonData = useMemo(() => lesson?.datasets.filter(dataset => !dataReady[dataset.id]) ?? [], [lesson, dataReady]);
  const installedLessonKeys = useMemo(() => new Set(catalog.flatMap(installed => registryEntries
    .filter(entry => entry.kind === "lesson" && entry.name === installed.id &&
      (installed.manifestSha256 ? entry.manifestSha256.toLowerCase() === installed.manifestSha256.toLowerCase() : entry.version === installed.version))
    .map(registryEntryKey))), [catalog, registryEntries]);
  const openLessonKeys = useMemo(() => new Set(documents.flatMap(document => {
    if (!document.lesson) return [];
    const revision = document.lessonManifestSha256 ?? catalog.find(item => item.id === document.lesson?.id)?.manifestSha256;
    return registryEntries.filter(entry => entry.kind === "lesson" && entry.name === document.lesson?.id &&
      (!revision || entry.manifestSha256.toLowerCase() === revision.toLowerCase())).map(registryEntryKey);
  })), [documents, catalog, registryEntries]);
  const modifiedLessonKeys = useMemo(() => new Set(documents.flatMap(document => {
    if (!document.lesson || !document.dirty) return [];
    const revision = document.lessonManifestSha256 ?? catalog.find(item => item.id === document.lesson?.id)?.manifestSha256;
    return registryEntries.filter(entry => entry.kind === "lesson" && entry.name === document.lesson?.id &&
      (!revision || entry.manifestSha256.toLowerCase() === revision.toLowerCase())).map(registryEntryKey);
  })), [documents, catalog, registryEntries]);
  const catalogWithRegistrySeries = useMemo(() => catalog.map(item => {
    if (item.series) return item;
    const candidates = registryEntries.filter(entry => entry.kind === "lesson" && entry.name === item.id && entry.series);
    const registered = candidates[0] ? latestRegistryEntry(candidates, candidates[0].id) : undefined;
    return registered?.series ? { ...item, series: registered.series } : item;
  }), [catalog, registryEntries]);
  const lessonSeries = useMemo(() => {
    const series = new Map<string, { id: string; title: string; url: string; items: CatalogEntry[] }>();
    const standalone: CatalogEntry[] = [];
    for (const item of catalogWithRegistrySeries) {
      if (!item.series) { standalone.push(item); continue; }
      const group = series.get(item.series.id) ?? { id: item.series.id, title: item.series.title, url: item.series.url, items: [] };
      group.items.push(item); series.set(item.series.id, group);
    }
    for (const group of series.values()) group.items.sort((left, right) =>
      (left.series?.order ?? 0) - (right.series?.order ?? 0) || left.title.localeCompare(right.title));
    return { groups: [...series.values()].sort((left, right) => left.title.localeCompare(right.title)), standalone };
  }, [catalogWithRegistrySeries]);
  const activeInstalledLesson = lesson ? catalogWithRegistrySeries.find(item => item.id === lesson.id) : undefined;
  const activeRegistryLesson = lesson ? registryEntries.find(entry => entry.kind === "lesson" && entry.name === lesson.id &&
    (!activeDocument.lessonManifestSha256 || entry.manifestSha256.toLowerCase() === activeDocument.lessonManifestSha256.toLowerCase())) : undefined;
  const activeSeriesGroup = activeInstalledLesson?.series ? lessonSeries.groups.find(group => group.id === activeInstalledLesson.series?.id) : undefined;
  const activeSeriesIndex = activeSeriesGroup ? activeSeriesGroup.items.findIndex(item => item.id === activeInstalledLesson?.id) : -1;
  const previousSeriesLesson = activeSeriesIndex > 0 ? activeSeriesGroup?.items[activeSeriesIndex - 1] : undefined;
  const nextSeriesLesson = activeSeriesGroup && activeSeriesIndex >= 0 && activeSeriesIndex < activeSeriesGroup.items.length - 1 ? activeSeriesGroup.items[activeSeriesIndex + 1] : undefined;
  const outdatedLessonKeys = useMemo(() => new Set(catalog.flatMap(installed => {
    const candidates = registryEntries.filter(entry => entry.kind === "lesson" && entry.name === installed.id);
    const registered = candidates[0] ? latestRegistryEntry(candidates, candidates[0].id) : undefined;
    return registered && lessonUpdateAvailable(installed, registered, location.href) ? [registryEntryKey(registered)] : [];
  })), [catalog, registryEntries]);
  const outdatedInstalledNames = useMemo(() => new Set(registryEntries
    .filter(entry => outdatedLessonKeys.has(registryEntryKey(entry))).map(entry => entry.name)), [registryEntries, outdatedLessonKeys]);
  const lessonUpdateInstalled = lessonUpdateEntry ? catalog.find(item => item.id === lessonUpdateEntry.name) : undefined;
  const selectedRegistryEntry = useMemo(() => registryEntries.find(entry => registryEntryKey(entry) === selectedRegistryKey) ?? null, [registryEntries, selectedRegistryKey]);
  const lessonLaunchRuntimeCompatible = !lessonLaunchReview || lessonLaunchReview.manifest.runtime === "browser" ||
    (lessonLaunchReview.manifest.runtime === "desktop" && kernelKind === "desktop") ||
    (lessonLaunchReview.manifest.runtime === "remote" && kernelKind === "somer");
  const exportIssues = useMemo(() => reportIssues({
    workspaceName, filename, generatedAt: "", cells,
    missingData: lesson?.datasets.filter(dataset => !dataReady[dataset.id]).map(dataset => dataset.path) ?? [],
    runRecord: activeDocument.lastRun,
  }), [workspaceName, filename, cells, lesson, dataReady, activeDocument.lastRun]);

  useEffect(() => {
    if (!lessonLaunchRequest || (lessonLaunchRequest.kind === "registry" && registrySource === "loading")) return;
    const registryEntry = lessonLaunchRequest.kind === "registry"
      ? registryEntries.find(entry => entry.kind === "lesson" && entry.id === lessonLaunchRequest.id && entry.version === lessonLaunchRequest.version)
      : undefined;
    if (lessonLaunchRequest.kind === "registry" && !registryEntry) {
      setLessonLaunchLoading(false);
      setLessonLaunchReview(null);
      setLessonLaunchError(`The registry does not contain ${lessonLaunchRequest.id}@${lessonLaunchRequest.version}. Ask the sender for an available exact version.`);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const manifestUrl = registryEntry?.manifest ?? (lessonLaunchRequest.kind === "manifest" ? lessonLaunchRequest.manifest : "");
    const expectedHash = registryEntry?.manifestSha256 ?? (lessonLaunchRequest.kind === "manifest" ? lessonLaunchRequest.sha256 : undefined);
    const expectedId = registryEntry?.name;
    setLessonLaunchLoading(true); setLessonLaunchError(""); setLessonLaunchReview(null);
    inspectLessonManifest(manifestUrl, location.href, expectedHash, expectedId, controller.signal).then(inspected => {
      if (active) setLessonLaunchReview({ request: lessonLaunchRequest, registryEntry, ...inspected });
    }).catch(error => {
      if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
      setLessonLaunchError(error instanceof Error ? error.message : String(error));
    }).finally(() => active && setLessonLaunchLoading(false));
    return () => { active = false; controller.abort(); };
  }, [lessonLaunchRequest, registryEntries, registrySource]);

  useEffect(() => {
    if (!runAfterPrepareRef.current || pendingLessonData.length || running || kernelState !== "ready") return;
    runAfterPrepareRef.current = false;
    void runTo(cells.length - 1, true);
  }, [pendingLessonData.length, running, kernelState, cells.length]);

  useEffect(() => {
    if (!pendingLaunchRunId || lesson?.id !== pendingLaunchRunId || running || kernelState !== "ready") return;
    setPendingLaunchRunId("");
    if (pendingLessonData.length) void prepareAndRunAll();
    else void runTo(cells.length - 1, true);
  }, [pendingLaunchRunId, lesson?.id, pendingLessonData.length, running, kernelState, cells.length]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRegistryDatasetDetails(null); setRegistryDetailError("");
    if (selectedRegistryEntry?.kind !== "dataset") { setRegistryDetailLoading(false); return () => { active = false; }; }
    setRegistryDetailLoading(true);
    fetchRegisteredDataset(selectedRegistryEntry, controller.signal).then(async manifest => {
      if (!active) return;
      setRegistryDatasetDetails(manifest);
      const cached = await Promise.all(manifest.files.map(file => hasDataset(asDatasetManifest(manifest, file))));
      if (active && cached.every(Boolean)) setPreparedRegistryDatasets(current => new Set(current).add(manifest.id));
    }).catch(error => {
      if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
      setRegistryDetailError(error instanceof Error ? error.message : String(error));
    })
      .finally(() => active && setRegistryDetailLoading(false));
    return () => { active = false; controller.abort(); };
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
        ...(document.lessonManifestSha256 ? { lessonManifestSha256: document.lessonManifestSha256 } : {}),
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
    const sourceChanged = patch.source !== undefined;
    const changesExecution = sourceChanged && cells[index]?.type === "code";
    updateDocument(activeDocumentId, document => ({
      ...document,
      cells: document.cells.map((cell, position) => {
        const updated = position === index ? { ...cell, ...patch } : cell;
        return changesExecution && position >= index && updated.type === "code" && updated.result ? { ...updated, status: "stale" } : updated;
      }),
      dirty: sourceChanged ? true : document.dirty,
    }));
    if (changesExecution) { needsResetRef.current = true; setValidThrough(current => Math.min(current, index - 1)); }
  }

  const editMarkdown = useCallback((index: number) => {
    setDocuments(current => current.map(document => document.id === activeDocumentId ? {
      ...document, cells: document.cells.map((cell, position) => position === index ? { ...cell, editing: true } : cell)
    } : document));
  }, [activeDocumentId]);

  function navigateWorkspace(view: WorkspaceView) {
    const url = new URL(location.href);
    if (view === "registry") url.searchParams.set("view", "registry");
    else ["view", "q", "kind", "category", "runtime", "access", "trust", "sort", "entry"].forEach(key => url.searchParams.delete(key));
    history.pushState(history.state, "", url); setWorkspaceView(view);
    if (view === "registry" && notice?.id === "welcome") setNotice(null);
  }

  function updateRegistryFilters(patch: Partial<RegistryViewState>) {
    setRegistryFilters(current => {
      const next = { ...current, ...patch };
      if (patch.kind && patch.kind !== "dataset") next.access = "all";
      return next;
    });
  }

  const selectRegistryEntry = useCallback((entry: RegistryEntry | null) => setSelectedRegistryKey(entry ? registryEntryKey(entry) : ""), []);

  async function openRegistryLesson(entry: RegistryEntry) {
    const installed = catalog.find(item => item.id === entry.name);
    if (!installed) return;
    if (lessonUpdateAvailable(installed, entry, location.href)) { setLessonUpdateEntry(entry); return; }
    await loadLesson(installed); navigateWorkspace("notebook");
  }

  async function openInstalledLesson(entry: CatalogEntry) {
    const candidates = registryEntries.filter(item => item.kind === "lesson" && item.name === entry.id);
    const registered = candidates[0] ? latestRegistryEntry(candidates, candidates[0].id) : undefined;
    if (registered && lessonUpdateAvailable(entry, registered, location.href)) {
      setLessonUpdateEntry(registered); return;
    }
    await loadLesson(entry);
  }

  async function copyRegistryCommand(entry: RegistryEntry) {
    const command = `bl data fetch ${entry.id}`;
    try {
      await navigator.clipboard.writeText(command);
      setNotice({ tone: "good", text: `Copied: ${command}` });
    } catch { setNotice({ tone: "info", text: command }); }
  }

  async function copyLessonLink(entry: RegistryEntry) {
    const link = registryLessonShareUrl(location.href, entry.id, entry.version);
    try {
      await navigator.clipboard.writeText(link);
      setNotice({ tone: "good", text: `Copied an exact-version link for ${entry.title}. Opening it will require an explicit install or run confirmation.` });
    } catch { setNotice({ tone: "info", text: link }); }
  }

  async function copyCatalogueLink(entry: RegistryEntry) {
    const link = publicRegistryUrl({}, registryEntryKey(entry));
    try {
      await navigator.clipboard.writeText(link);
      setNotice({ tone: "good", text: `Copied the public catalogue page for ${entry.title}.` });
    } catch { setNotice({ tone: "info", text: link }); }
  }

  async function copyChecksumLessonLink(entry: RegistryEntry) {
    const link = manifestLessonShareUrl(location.href, entry.manifest, entry.manifestSha256);
    try {
      await navigator.clipboard.writeText(link);
      setNotice({ tone: "good", text: `Copied a Studio link pinned directly to ${entry.title}'s manifest checksum.` });
    } catch { setNotice({ tone: "info", text: link }); }
  }

  async function shareActiveLesson() {
    if (!lesson) return;
    const installed = catalog.find(item => item.id === lesson.id);
    if (!installed) { setNotice({ tone: "bad", text: "This notebook is not associated with an installed lesson package." }); return; }
    const registered = registryEntries.find(entry => entry.kind === "lesson" && entry.name === lesson.id &&
      entry.manifestSha256.toLowerCase() === installed.manifestSha256?.toLowerCase());
    const link = registered
      ? registryLessonShareUrl(location.href, registered.id, registered.version)
      : manifestLessonShareUrl(location.href, installed.manifest, installed.manifestSha256);
    try {
      await navigator.clipboard.writeText(link);
      setNotice({ tone: "good", text: registered ? "Copied an exact registry lesson link." : "Copied a checksum-pinned direct lesson link." });
    } catch { setNotice({ tone: "info", text: link }); }
  }

  function closeLessonLaunch() {
    history.replaceState(history.state, "", removeLessonLaunchParams(location.href));
    setLessonLaunchRequest(null); setLessonLaunchReview(null); setLessonLaunchError(""); setLessonLaunchLoading(false);
  }

  async function installSharedLesson(runAll: boolean) {
    if (!lessonLaunchReview || lessonLaunchBusy) return;
    setLessonLaunchBusy(true);
    try {
      const expectedHash = lessonLaunchReview.registryEntry?.manifestSha256 ?? lessonLaunchReview.observedSha256;
      const expectedId = lessonLaunchReview.registryEntry?.name ?? lessonLaunchReview.manifest.id;
      const installed = catalog.find(item => item.id === expectedId);
      const sameInstalledRevision = Boolean(
        installed?.manifestSha256 && expectedHash &&
        installed.manifestSha256.toLowerCase() === expectedHash.toLowerCase(),
      );
      const manifest = await installFromManifest(
        lessonLaunchReview.manifestUrl,
        expectedHash,
        expectedId,
        !sameInstalledRevision,
        lessonLaunchReview.registryEntry?.version,
      );
      closeLessonLaunch();
      navigateWorkspace("notebook");
      if (runAll) {
        setPendingLaunchRunId(manifest.id);
        setNotice({ tone: "good", text: `${manifest.title} was installed from the reviewed link. Studio will prepare its verified data and run all cells when the selected kernel is ready.` });
      } else {
        setNotice({ tone: "good", text: `${manifest.title} was checksum-verified, installed, and opened without running code.` });
      }
    } catch (error) {
      setLessonLaunchError(error instanceof Error ? error.message : String(error));
    } finally { setLessonLaunchBusy(false); }
  }

  async function refreshVariables() {
    try { setVariables(await kernelRef.current!.listVariables()); } catch { setVariables([]); }
    finally { setVariableRevision(current => current + 1); }
  }

  async function runTo(end: number, restart = false) {
    if (running) return;
    if (!kernelRef.current || kernelState !== "ready") {
      setNotice({ tone: "info", text: "BioLang is still starting. Run will be available when the kernel status changes to ready." });
      return;
    }
    if (codeLanguage === "javascript" && cells.slice(0, end + 1).some(cell => cell.type === "code" && cell.javascriptSource) && !kernelRef.current.executeJavaScript) {
      setNotice({ tone: "info", text: "Edited JavaScript cells run in the Browser kernel. Desktop and SOMER can run the canonical BioLang tab; the JavaScript SDK can also submit generated BioLang programs directly to SOMER." });
      return;
    }
    if (pendingLessonData.length) {
      const names = pendingLessonData.map(dataset => dataset.path).join(", ");
      setNotice({ tone: "info", text: `Prepare the lesson data before running. BioLang cannot open ${names} until ${pendingLessonData.length === 1 ? "it is" : "they are"} downloaded, checksum-verified, and attached.` });
      return;
    }
    setRunning(true); setNotice(null);
    stopRequestedRef.current = false;
    const runStartedAt = new Date();
    const runStarted = performance.now();
    const runNotebookId = activeDocumentId;
    const runFilename = filename;
    const runLanguage = codeLanguage;
    const runSource = serializeNotebook(cells);
    const runnableCells = cells.slice(0, end + 1).filter(cell => cell.type === "code" && !directives(cell.source).skip);
    let compiledEntries: Array<readonly [string, ReturnType<typeof compileNotebookCode>]>;
    try {
      compiledEntries = await Promise.all(runnableCells.map(async cell => {
        const biolangSource = executableSource(cell.source);
        let javascriptSource = javascriptTranslations[cell.id]?.biolangSource === biolangSource
          ? javascriptTranslations[cell.id].javascriptSource : undefined;
        if (runLanguage === "javascript" && !javascriptSource) {
          if (!kernelRef.current?.transpileJavaScript) throw new Error("This JavaScript cell has not been translated yet. Switch to the Browser kernel once to prepare its structural JavaScript frontend.");
          javascriptSource = await kernelRef.current.transpileJavaScript(biolangSource);
          setJavascriptTranslations(current => ({ ...current, [cell.id]: { biolangSource, javascriptSource } }));
        }
        return [cell.id, compileNotebookCode(biolangSource, runLanguage, javascriptSource)] as const;
      }));
    } catch (error) {
      setRunning(false);
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
      return;
    }
    const compiledByCell = new Map(compiledEntries);
    const compiledCells = compiledEntries.map(([, compiled]) => compiled).filter(compiled => Boolean(compiled.biolangSource));
    const executedSource = compiledCells.map(compiled => compiled.biolangSource).join("\n\n");
    const frontendSource = compiledCells.map(compiled => compiled.frontendSource).join("\n\n");
    const runInputs = visibleAttachments.filter(attachment => !missingAttachmentIds.has(attachment.id)).map(attachment => ({
      path: attachment.path, size: attachment.size, sha256: attachment.sha256,
      mediaType: attachment.mediaType, sourceKind: attachment.source.kind,
    }));
    let runSucceeded = false;
    let runError: string | undefined;
    let executingIndex = -1;
    const actualExecutedSources: string[] = [];
    let start = Math.max(0, validThrough + 1);
    try {
      if (restart || needsResetRef.current || end <= validThrough || kernelKind === "somer") {
        await kernelRef.current.reset(); needsResetRef.current = false; start = 0; setValidThrough(-1);
        updateDocument(runNotebookId, document => ({ ...document, cells: document.cells.map(cell => cell.type === "code" && cell.result ? { ...cell, status: "stale" } : cell) }));
      }
      if (kernelKind === "somer") {
        const runnable = compiledCells.map(compiled => compiled.biolangSource);
        const result = await kernelRef.current.execute(runnable.join("\n\n"));
        updateCell(end, { status: result.ok ? "done" : "error", result });
        if (!result.ok) { runError = result.error ?? "Remote execution failed."; setNotice({ tone: "bad", text: runError }); return; }
        runSucceeded = true;
        setValidThrough(end); setNotice({ tone: "good", text: `SOMER ran ${runnable.length} ${runLanguage === "javascript" ? "JavaScript → BioLang" : "BioLang"} code cells as one reproducible job.` }); return;
      }
      for (let index = start; index <= end; index++) {
        const cell = cells[index];
        if (!cell || cell.type !== "code") { setValidThrough(index); continue; }
        const instruction = directives(cell.source);
        const source = compiledByCell.get(cell.id)?.biolangSource ?? executableSource(cell.source);
        if (instruction.skip || !source) { updateCell(index, { status: "skipped", result: undefined }); setValidThrough(index); continue; }
        executingIndex = index;
        updateCell(index, { status: "running", result: undefined });
        const compiled = compiledByCell.get(cell.id);
        const result = runLanguage === "javascript" && compiled?.frontendSource && kernelRef.current.executeJavaScript
          ? await kernelRef.current.executeJavaScript(compiled.frontendSource, source)
          : await kernelRef.current.execute(source);
        actualExecutedSources.push(result.compiledSource ?? source);
        updateCell(index, { status: result.ok ? "done" : "error", result });
        if (!result.ok) {
          runError = result.error ?? "Execution failed."; setValidThrough(index - 1);
          updateDocument(runNotebookId, document => ({ ...document, cells: document.cells.map((item, position) => position > index && item.type === "code" && item.result ? { ...item, status: "stale" } : item) }));
          setNotice({ tone: "bad", text: `Stopped at cell ${index + 1}: ${runError}` });
          setTimeout(() => document.querySelector(`[data-cell-index="${index}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
          return;
        }
        setValidThrough(index);
        executingIndex = -1;
      }
      await refreshVariables();
      runSucceeded = true;
      setNotice({ tone: "good", text: `Finished through cell ${end + 1} using ${runLanguage === "javascript" ? "JavaScript compiled to BioLang" : "BioLang"}. Earlier code cells were run when needed.` });
    } catch (error) {
      runError = stopRequestedRef.current ? "Cancelled by user" : error instanceof Error ? error.message : String(error);
      if (stopRequestedRef.current) updateDocument(runNotebookId, document => ({ ...document, cells: document.cells.map(cell => cell.status === "running" ? { ...cell, status: "stale" } : cell) }));
      else if (executingIndex >= 0) {
        const failed: ExecutionResult = { ok: false, error: runError, backend: kernelKind };
        updateDocument(runNotebookId, document => ({ ...document, cells: document.cells.map((item, position) => position === executingIndex ? { ...item, status: "error", result: failed } : position > executingIndex && item.type === "code" && item.result ? { ...item, status: "stale" } : item) }));
        setValidThrough(executingIndex - 1);
        setTimeout(() => document.querySelector(`[data-cell-index="${executingIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      }
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
          id: runNotebookId, filename: runFilename, sourceLanguage: runLanguage, sourceSha256: await sha256(runSource),
          frontendSourceSha256: await sha256(frontendSource), executedSourceSha256: await sha256(actualExecutedSources.length ? actualExecutedSources.join("\n\n") : executedSource), executedThrough: end,
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

  async function loadLesson(entry: CatalogEntry, propagateError = false, openFresh = false) {
    try {
      const expectedRevision = entry.manifestSha256?.toLowerCase();
      const existing = documents.find(document => document.lesson?.id === entry.id &&
        (!expectedRevision || document.lessonManifestSha256?.toLowerCase() === expectedRevision));
      if (existing && !openFresh) {
        const remembered = collectionSelectionRef.current[collectionKey(existing)];
        setActiveDocumentId(documents.some(document => document.id === remembered) ? remembered : existing.id);
        return;
      }
      const manifestUrl = new URL(entry.manifest, location.href);
      const manifestResponse = await fetch(manifestUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!manifestResponse.ok) throw new Error(`Lesson manifest returned HTTP ${manifestResponse.status}.`);
      const manifestText = await manifestResponse.text();
      if (entry.manifestSha256) {
        const actual = await sha256(manifestText);
        if (actual.toLowerCase() !== entry.manifestSha256.toLowerCase()) throw new Error("The lesson manifest no longer matches its installed registry checksum. Studio did not trust the changed content. Refresh the Registry and choose Update if a new checksum is available.");
      }
      const manifest = validateManifest(JSON.parse(manifestText), { allowLoopback: isLoopbackUrl(manifestUrl) });
      const lessonEntries = manifestLessonEntries(manifest);
      const openedDocuments = await Promise.all(lessonEntries.map(async lessonEntry => {
        const sourceResponse = await fetch(new URL(lessonEntry.entry, manifestUrl), { credentials: "omit", referrerPolicy: "no-referrer" });
        if (!sourceResponse.ok) throw new Error(`${lessonEntry.title} returned HTTP ${sourceResponse.status}.`);
        return createNotebook(`${lessonEntry.id}.bln`, await sourceResponse.text(), manifest, entry.manifestSha256);
      }));
      const states = Object.fromEntries(await Promise.all(manifest.datasets.map(async dataset => {
        const cached = await hasDataset(dataset);
        if (cached) {
          const file = await prepareDataset(dataset);
          if (manifest.schema === 2) {
            await registerAttachment(file, dataset.mediaType, { kind: "dataset", dataset }, { kind: "workspace" }, false);
          } else {
            await registerAttachment(file, dataset.mediaType, { kind: "dataset", dataset }, { kind: "notebook", notebookId: openedDocuments[0].id }, false);
          }
        }
        return [dataset.id, cached];
      })));
      for (const document of openedDocuments) document.dataReady = states;
      setDocuments(current => [...current, ...openedDocuments]); setActiveDocumentId(openedDocuments[0].id); needsResetRef.current = false;
      setNotice({ tone: "info", text: openedDocuments.length === 1
        ? `Opened ${manifest.title} in a new tab. Prepare its declared data before running.`
        : `Opened ${manifest.title} as one lesson with ${openedDocuments.length} selectable sections.` });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
      if (propagateError) throw error;
    }
  }

  async function restoreOriginalLesson() {
    if (!lesson) return;
    const catalogEntry = catalog.find(entry => entry.id === lesson.id);
    if (!catalogEntry) {
      setNotice({ tone: "bad", text: "This lesson package is not installed. Reinstall it from the Registry before restoring its original notebook." });
      return;
    }
    if (!window.confirm(`Restore ${filename} from ${lesson.title}?\n\nEdited cells and outputs in this notebook will be replaced. Prepared data and workspace attachments will remain available.`)) return;
    try {
      const manifestUrl = new URL(catalogEntry.manifest, location.href);
      const manifestResponse = await fetch(manifestUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!manifestResponse.ok) throw new Error(`Lesson manifest returned HTTP ${manifestResponse.status}.`);
      const manifestText = await manifestResponse.text();
      if (catalogEntry.manifestSha256) {
        const actual = await sha256(manifestText);
        if (actual.toLowerCase() !== catalogEntry.manifestSha256.toLowerCase()) throw new Error("The lesson manifest no longer matches its installed registry checksum. Studio did not trust the changed content. Refresh the Registry and choose Update if a new checksum is available.");
      }
      const restoredManifest = validateManifest(JSON.parse(manifestText), { allowLoopback: isLoopbackUrl(manifestUrl) });
      if (restoredManifest.id !== lesson.id) throw new Error(`The installed package now identifies itself as '${restoredManifest.id}', not '${lesson.id}'.`);
      const lessonDocuments = documents.filter(document => document.lesson?.id === lesson.id);
      const siblingIndex = Math.max(0, lessonDocuments.findIndex(document => document.id === activeDocumentId));
      const originalEntry = lessonEntryForDocument(restoredManifest, filename, siblingIndex);
      const sourceResponse = await fetch(new URL(originalEntry.entry, manifestUrl), { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!sourceResponse.ok) throw new Error(`${originalEntry.title} returned HTTP ${sourceResponse.status}.`);
      const originalSource = await sourceResponse.text();
      updateDocument(activeDocumentId, document => {
        const { lastRun: _discardedRun, ...rest } = document;
        return {
          ...rest,
          filename: `${originalEntry.id}.bln`,
          cells: parseNotebook(originalSource),
          lesson: restoredManifest,
          lessonManifestSha256: catalogEntry.manifestSha256,
          validThrough: -1,
          dirty: Boolean(document.nativeFile),
        };
      });
      needsResetRef.current = false;
      setCollapsedSteps(new Set());
      setKernelEpoch(current => current + 1);
      setNotice({ tone: "good", text: `${originalEntry.title} was restored from its checksum-verified lesson package. Prepared data and attachments were kept.` });
    } catch (error) {
      setNotice({ tone: "bad", text: `Could not restore the lesson: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function refreshRegistry() {
    setRegistrySource("loading"); setRegistryError("");
    try {
      const result = await fetchRegistry();
      setRegistryEntries(result.index.entries); setRegistrySource(result.source); setRegistryCheckedAt(result.checkedAt);
    } catch (error) {
      setRegistryEntries([]); setRegistrySource("unavailable"); setRegistryCheckedAt("");
      setRegistryError(error instanceof Error ? error.message : String(error));
    }
  }

  async function installFromManifest(rawUrl: string, expectedHash?: string, expectedId?: string, openFresh = false, version?: string) {
    const inspected = await inspectLessonManifest(rawUrl, location.href, expectedHash, expectedId);
    const { manifest, manifestUrl, observedSha256 } = inspected;
    const candidate: CatalogEntry = {
      id: manifest.id, title: manifest.title, summary: manifest.summary, manifest: manifestUrl,
      runtime: manifest.runtime, tags: manifest.tags, manifestSha256: observedSha256, version,
      series: manifest.series
    };
    await loadLesson(candidate, true, openFresh);
    const next = installLesson(manifest, manifestUrl, observedSha256, version);
    setCatalog(next);
    return manifest;
  }

  function markLessonDatasetReady(datasetId: string) {
    if (lesson?.schema !== 2) {
      setDataReady(current => ({ ...current, [datasetId]: true }));
      return;
    }
    const key = collectionKey(activeDocument);
    setDocuments(current => current.map(document => collectionKey(document) === key
      ? { ...document, dataReady: { ...document.dataReady, [datasetId]: true } }
      : document));
  }

  async function prepare(id: string): Promise<boolean> {
    const dataset = lesson?.datasets.find(item => item.id === id);
    if (!dataset || !kernelRef.current) return false;
    try {
      if (kernelKind === "browser" && dataset.bytes > 50 * 1024 ** 2) throw new Error(`${dataset.title} is larger than the 50 MB browser guidance limit. Use BioLang Desktop or SOMER for this lesson.`);
      if (kernelKind === "desktop" && kernelRef.current.fetchRemote) {
        if (dataset.bytes > MAX_NATIVE_DATA_BYTES) throw new Error(`${dataset.title} exceeds Studio Desktop's ${displayBytes(MAX_NATIVE_DATA_BYTES)} per-file safety limit.`);
        setNotice({ tone: "info", text: `Streaming ${dataset.title} into private native storage…` });
        const native = await kernelRef.current.fetchRemote({
          url: dataset.url, path: dataset.path, mediaType: dataset.mediaType,
          expectedBytes: dataset.bytes, expectedSha256: dataset.sha256,
        });
        registerNativeReference(native, { kind: "dataset", dataset }, lesson?.schema === 2 ? { kind: "workspace" } : { kind: "notebook", notebookId: activeDocumentId });
        markLessonDatasetReady(id);
        setNotice({ tone: "good", text: `${dataset.title} was streamed to private native storage, checksum-verified, and mounted as ${dataset.path}.` });
        return true;
      }
      setNotice({ tone: "info", text: `Downloading ${dataset.title} from its declared source…` });
      const file = await prepareDataset(dataset, loaded => setProgress(current => ({ ...current, [id]: loaded })));
      await registerAttachment(file, dataset.mediaType, { kind: "dataset", dataset }, lesson?.schema === 2 ? { kind: "workspace" } : { kind: "notebook", notebookId: activeDocumentId });
      markLessonDatasetReady(id);
      setNotice({ tone: "good", text: `${dataset.title} is verified and ready as ${dataset.path}.` });
      return true;
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); return false; }
  }

  async function prepareAllLessonData(): Promise<boolean> {
    if (!pendingLessonData.length) return true;
    setNotice({ tone: "info", text: `Preparing ${pendingLessonData.length} lesson file${pendingLessonData.length === 1 ? "" : "s"}. Each download is checksum-verified before BioLang can read it.` });
    for (const dataset of pendingLessonData) {
      if (!await prepare(dataset.id)) return false;
    }
    setNotice({ tone: "good", text: `${pendingLessonData.length} lesson file${pendingLessonData.length === 1 ? " is" : "s are"} prepared and attached. You can run the notebook now.` });
    return true;
  }

  async function prepareAndRunAll() {
    runAfterPrepareRef.current = true;
    if (!await prepareAllLessonData()) runAfterPrepareRef.current = false;
  }

  async function addPackage() {
    try {
      const manifest = await installFromManifest(packageUrl);
      const lessonCount = manifestLessonEntries(manifest).length;
      setPackageOpen(false); setPackageUrl("");
      setNotice({ tone: "good", text: lessonCount === 1
        ? `${manifest.title} was added to this browser. Its data remains unprepared until you request it.`
        : `${manifest.title} was added as one lesson with ${lessonCount} selectable sections. Its data remains unprepared until you request it.` });
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
  }

  async function installRegistryEntry(entry: RegistryEntry) {
    const updating = lessonUpdateAvailable(catalog.find(item => item.id === entry.name), entry, location.href);
    setInstallingId(entry.id);
    try {
      const manifest = await installFromManifest(entry.manifest, entry.manifestSha256, entry.name, false, entry.version);
      const lessonCount = manifestLessonEntries(manifest).length;
      setNotice({ tone: "good", text: updating
        ? `${manifest.title} was updated after its new registry checksum was verified. Existing notebooks and prepared data were kept.`
        : lessonCount === 1
          ? `${manifest.title} was checksum-verified and installed. Its data remains unprepared until you request it.`
          : `${manifest.title} was checksum-verified and installed as one lesson with ${lessonCount} selectable sections. Its data remains unprepared until you request it.` });
      navigateWorkspace("notebook");
    } catch (error) { setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }); }
    finally { setInstallingId(""); }
  }

  async function confirmLessonUpdate() {
    const entry = lessonUpdateEntry;
    if (!entry) return;
    await installRegistryEntry(entry);
    setLessonUpdateEntry(null);
  }

  function installOrReviewRegistryEntry(entry: RegistryEntry) {
    const installed = entry.kind === "lesson" ? catalog.find(item => item.id === entry.name) : undefined;
    if (installed && lessonUpdateAvailable(installed, entry, location.href)) { setLessonUpdateEntry(entry); return; }
    void installRegistryEntry(entry);
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
    setDocuments(current => current.map(document => document.lesson?.id === entry.id ? { ...document, lesson: null, lessonManifestSha256: undefined, dataReady: {}, dirty: true } : document));
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
    catch (error) { setUrlDataError(error instanceof Error ? error.message : String(error)); }
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
      setUrlDataError(error instanceof Error ? error.message : String(error));
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

  function createGuidedStatisticsNotebook(title: string, source: string) {
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "statistics-analysis"}.bln`;
    const document = createNotebook(filename, source);
    document.dirty = true;
    setDocuments(current => [...current, document]);
    setActiveDocumentId(document.id);
    setWorkspaceView("notebook");
    setStatisticsGuideOpen(false);
    setNotice({ tone: "info", text: "Attach the named CSV, review the generated method, then run the notebook in order." });
  }

  function switchNotebook(id: string) {
    if (id === activeDocumentId || running) return;
    needsResetRef.current = false; setCollapsedSteps(new Set()); setActiveDocumentId(id);
    setNotice({ tone: "info", text: "Notebook variables are isolated. Saved outputs remain visible but replay before relying on them." });
  }

  function switchDocumentGroup(group: DocumentTabGroup) {
    if (group.documents.some(document => document.id === activeDocumentId) || running) return;
    const remembered = collectionSelectionRef.current[group.key];
    const target = group.documents.find(document => document.id === remembered) ?? group.documents[0];
    switchNotebook(target.id);
  }

  function switchLessonSection(entryId: string) {
    if (!lesson || lesson.schema !== 2 || running) return;
    const target = documents.find(document => collectionKey(document) === collectionKey(activeDocument) &&
      document.filename.replace(/\.bln$/i, "") === entryId);
    if (target) switchNotebook(target.id);
  }

  function closeDocumentGroup(group: DocumentTabGroup) {
    if (running) return;
    if (group.documents.length === 1) { closeNotebook(group.documents[0].id); return; }
    const dirty = group.documents.filter(document => document.dirty);
    if (dirty.length && !window.confirm(`Close ${group.label} and its ${group.documents.length} sections?\n\n${dirty.length} section${dirty.length === 1 ? " has" : "s have"} unsaved changes.`)) return;
    const closingIds = new Set(group.documents.map(document => document.id));
    const declaredDatasetIds = new Set(group.documents[0].lesson?.datasets.map(dataset => dataset.id) ?? []);
    const retainedAttachments = workspaceAttachmentsRef.current.filter(attachment =>
      !(attachment.scope.kind === "workspace" && attachment.source.kind === "dataset" && declaredDatasetIds.has(attachment.source.dataset.id)) &&
      (attachment.scope.kind === "workspace" || !closingIds.has(attachment.scope.notebookId)));
    workspaceAttachmentsRef.current = retainedAttachments;
    setWorkspaceAttachments(retainedAttachments);
    const remaining = documents.filter(document => !closingIds.has(document.id));
    setLastClosed(null);
    if (!remaining.length) {
      const replacement = createNotebook();
      setDocuments([replacement]);
      setActiveDocumentId(replacement.id);
    } else {
      setDocuments(remaining);
      if (closingIds.has(activeDocumentId)) setActiveDocumentId(remaining[0].id);
    }
    delete collectionSelectionRef.current[group.key];
    setNotice({ tone: "info", text: `Closed ${group.label}. Its sections were kept together as one lesson collection.` });
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

  async function exportNotebook(format: ReportFormat, options: ReportOptions) {
    let printTarget: Window | null = null;
    if (format === "pdf") {
      printTarget = window.open("", "_blank");
      if (!printTarget) { setNotice({ tone: "bad", text: "The print view was blocked. Allow pop-ups for Studio and try again." }); return; }
      printTarget.document.write("<!doctype html><title>Preparing BioLang report</title><p style='font-family:system-ui;padding:2rem'>Preparing print view…</p>");
    }
    setExportBusy(true);
    try {
      if (format === "notebook" || format === "script" || format === "project") {
        const projectExporter = await import("./export/lesson-project");
        const input = {
          filename: filename.trim() || "untitled.bln",
          workspaceName: workspaceName.trim() || "BioLang workspace",
          cells,
          lesson,
          lessonVersion: activeInstalledLesson?.version,
          lessonManifestUrl: activeInstalledLesson?.manifest,
          lessonManifestSha256: activeDocument.lessonManifestSha256 ?? activeInstalledLesson?.manifestSha256,
        };
        const base = projectExporter.safeProjectBase(input.filename);
        let blob: Blob;
        let downloadName: string;
        if (format === "notebook") {
          blob = new Blob([serializeNotebook(cells)], { type: "text/markdown;charset=utf-8" });
          downloadName = `${base}.bln`;
        } else if (format === "script") {
          blob = new Blob([projectExporter.generatedBioLangScript(cells, `${base}.bln`)], { type: "text/plain;charset=utf-8" });
          downloadName = `${base}.bl`;
        } else {
          const project = projectExporter.buildLessonProject(input);
          blob = new Blob([project.bytes], { type: "application/zip" });
          downloadName = project.filename;
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = downloadName; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setExportOpen(false);
        setNotice({ tone: "good", text: format === "notebook" ? "Downloaded the editable .bln notebook." : format === "script" ? "Downloaded the executable .bl script." : "Downloaded a CLI project with an integrity-checked data preparation lock." });
        return;
      }
      const report: NotebookReport = {
        workspaceName: workspaceName.trim() || "BioLang workspace", filename: filename.trim() || "untitled.bln",
        generatedAt: new Date().toISOString(), cells,
        ...(lesson ? { lesson: { title: lesson.title, sourceTitle: lesson.source.title, sourceUrl: lesson.source.url } } : {}),
        missingData: lesson?.datasets.filter(dataset => !dataReady[dataset.id]).map(dataset => dataset.path) ?? [],
        runRecord: activeDocument.lastRun,
      };
      const exporter = await import("./export/report");
      if (format === "html") await exporter.exportHtml(report, options);
      else if (format === "markdown") exporter.exportMarkdown(report, options);
      else exporter.openPrintReport(report, options, printTarget!);
      setExportOpen(false);
      setNotice({ tone: "good", text: format === "html" ? "Exported a self-contained HTML report." : format === "markdown" ? "Exported a Markdown ZIP with figures and provenance." : "Opened the print-ready report. Choose Save as PDF in the browser print dialog." });
    } catch (error) {
      printTarget?.close();
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    } finally { setExportBusy(false); }
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
      lessonManifestSha256: notebook.lessonManifestSha256,
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

  function insertCodeAfter(index: number) {
    const insertion = index + 1;
    needsResetRef.current = true;
    setValidThrough(current => Math.min(current, index));
    setCells(current => [
      ...current.slice(0, insertion),
      { id: crypto.randomUUID(), type: "code", source: "# BioLang code", editing: true, status: "" },
      ...current.slice(insertion).map(cell => cell.type === "code" && cell.result ? { ...cell, status: "stale" as const } : cell),
    ]);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-cell-index="${insertion}"] .cm-content`)?.focus());
  }

  function moveCell(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= cells.length) return;
    const affectsCode = cells[index].type === "code" || cells[target].type === "code";
    const start = Math.min(index, target);
    setCells(current => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return affectsCode ? next.map((cell, position) => position >= start && cell.type === "code" && cell.result ? { ...cell, status: "stale" as const } : cell) : next;
    });
    if (affectsCode) { needsResetRef.current = true; setValidThrough(current => Math.min(current, start - 1)); }
  }

  function deleteCell(index: number) {
    const cell = cells[index];
    if (!cell || ((cell.source.trim() || cell.result) && !window.confirm(`Delete cell ${index + 1}? No undo is available.`))) return;
    setCells(current => current.filter((_, position) => position !== index).map((item, position) =>
      cell.type === "code" && position >= index && item.type === "code" && item.result ? { ...item, status: "stale" as const } : item));
    if (cell.type === "code") { needsResetRef.current = true; setValidThrough(current => Math.min(current, index - 1)); }
  }

  async function copyCodeCell(cell: Cell, index: number, language: NotebookCodeLanguage) {
    const source = language === "javascript"
      ? javascriptTranslations[cell.id]?.javascriptSource ?? ""
      : cell.source;
    if (!source) {
      setNotice({ tone: "bad", text: javascriptTranslations[cell.id]?.error ?? "The JavaScript frontend is still being generated." });
      return;
    }
    try {
      await navigator.clipboard.writeText(source);
      setNotice({ tone: "good", text: `Copied ${language === "javascript" ? "JavaScript" : "BioLang"} code from cell ${index + 1}.` });
    } catch {
      setNotice({ tone: "bad", text: "The browser did not allow clipboard access. Select the code and copy it manually." });
    }
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
    const runAction = cell.status === "done" ? { glyph: "↻", label: "Run again", state: "Ran" }
      : cell.status === "error" ? { glyph: "↻", label: "Retry", state: "Failed" }
      : cell.status === "stale" ? { glyph: "▶", label: "Rerun required", state: "Stale" }
      : cell.status === "running" ? { glyph: "◌", label: "Running", state: "Running" }
      : cell.status === "skipped" ? { glyph: "↻", label: "Run again", state: "Skipped" }
      : { glyph: "▶", label: "Run", state: "Not run" };
    const displayedSource = cell.type === "code" && codeLanguage === "javascript"
      ? javascriptTranslations[cell.id]?.javascriptSource ?? (javascriptTranslations[cell.id]?.error ? `// Cannot translate this cell yet:\n// ${javascriptTranslations[cell.id].error}` : "// Generating structural JavaScript…")
      : cell.source;
    const javascriptEditable = codeLanguage === "javascript" && Boolean(kernelRef.current?.executeJavaScript) && displayedSource.startsWith("// Direct JavaScript API;");
    const javascriptKnownNames = cells.slice(0, index).flatMap(item => {
      const source = javascriptTranslations[item.id]?.javascriptSource ?? "";
      return [...source.matchAll(/^\s*(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=/gm)].map(match => match[1]);
    });
    return <article className={`cell cell-${cell.type} ${cell.status ?? ""}`} data-cell-index={index} key={cell.id}>
      <div className="cell-rail">{cell.type === "code" ? <><button aria-label={`${runAction.label} cell ${index + 1}`} title={cell.status === "done" ? "Run again from a clean interpreter; earlier cells will replay" : `${runAction.label}; required earlier cells run automatically`} disabled={running || kernelState !== "ready"} onClick={() => void runTo(index)}>{runAction.glyph}</button><small>{index + 1}</small><em>{runAction.state}</em></> : <><span>¶</span><small>{index + 1}</small></>}</div>
      <div className="cell-body">
        {cell.type === "code" && <><div className="code-language-tabs" role="tablist" aria-label={`Cell ${index + 1} language`}><button role="tab" aria-selected={codeLanguage === "biolang"} className={codeLanguage === "biolang" ? "active" : ""} onClick={() => setCodeLanguage("biolang")}>BioLang</button><button role="tab" aria-selected={codeLanguage === "javascript"} className={codeLanguage === "javascript" ? "active" : ""} onClick={() => setCodeLanguage("javascript")}>JavaScript</button><span>{codeLanguage === "javascript" ? (javascriptEditable ? "Safe JavaScript API · editable · Browser BioLang kernel" : kernelKind === "browser" ? "Structural JavaScript view · edit BioLang source" : "JavaScript view · use Browser kernel to edit") : "Canonical lesson source · live checks"}</span></div><button className="cell-copy-action" aria-label={`Copy ${codeLanguage === "javascript" ? "JavaScript" : "BioLang"} code from cell ${index + 1}`} title={`Copy this ${codeLanguage === "javascript" ? "JavaScript SDK code" : "BioLang code"}`} disabled={!displayedSource} onClick={() => void copyCodeCell(cell, index, codeLanguage)}>Copy</button></>}
        {cell.type === "code" ? <CodeEditor
          label={codeLanguage === "javascript" ? `JavaScript equivalent for cell ${index + 1}` : `BioLang cell ${index + 1}`}
          language={codeLanguage}
          value={displayedSource}
          readOnly={codeLanguage === "javascript" && !javascriptEditable}
          knownNames={javascriptKnownNames}
          diagnostics={source => kernelRef.current?.diagnostics?.(source) ?? Promise.resolve([])}
          completions={prefix => kernelRef.current?.completions?.(prefix) ?? Promise.resolve([])}
          onChange={source => {
            if (codeLanguage === "biolang") updateCell(index, { source, javascriptSource: undefined });
            else {
              updateCell(index, { javascriptSource: source });
              setJavascriptTranslations(current => ({ ...current, [cell.id]: { biolangSource: executableSource(cell.source), javascriptSource: source, edited: true } }));
            }
          }}
          onRun={advance => {
            void runTo(index);
            if (advance) requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>("article.cell-code .cm-content")].find(editor => Number(editor.closest("article")?.dataset.cellIndex) > index)?.focus());
          }}
        /> : cell.type === "markdown" && !cell.editing ? <><button className="markdown-edit-action" onClick={() => editMarkdown(index)}>Edit</button><MarkdownView source={cell.source} index={index} edit={editMarkdown}/></> : <AutoGrowTextarea label={`${cell.type} cell ${index + 1}`} className="markdown-editor" value={cell.source} spellCheck change={source => updateCell(index, { source })} blur={() => finishMarkdownCell(index)}/>}
        {cell.type === "code" && <ResultView result={cell.result} />}
      </div>
      <div className="cell-actions"><button aria-label={`Move cell ${index + 1} up`} title="Move cell up" disabled={index === 0} onClick={() => moveCell(index, -1)}>↑</button><button aria-label={`Move cell ${index + 1} down`} title="Move cell down" disabled={index === cells.length - 1} onClick={() => moveCell(index, 1)}>↓</button><button aria-label={`Insert code after cell ${index + 1}`} title="Insert code cell below" onClick={() => insertCodeAfter(index)}>＋</button><button aria-label={`Delete cell ${index + 1}`} title="Delete cell" onClick={() => deleteCell(index)}>×</button></div>
    </article>;
  }

  function renderInstalledLesson(item: CatalogEntry) {
    const exactRegistryEntry = registryEntries.find(entry => entry.kind === "lesson" && entry.name === item.id && entry.manifestSha256.toLowerCase() === item.manifestSha256?.toLowerCase());
    const version = item.version ?? exactRegistryEntry?.version;
    const updateAvailable = outdatedInstalledNames.has(item.id);
    return <div className={`lesson-row ${lesson?.id === item.id ? "active" : ""}`} key={item.id}><button className="lesson-link" title={`Open ${item.title}`} onClick={() => void openInstalledLesson(item)}><strong>{item.series?.chapter || item.title}</strong><small className="lesson-meta"><span title={version ? `Installed version ${version}` : "A lesson added from a custom or local manifest"}>{version ? `v${version}` : "Local"}</span>{updateAvailable && <em title="A registry update is available"><i aria-hidden="true"/>Update</em>}</small></button><button className="lesson-info" aria-label={`About ${item.title}`} title="Lesson details" onClick={() => setLessonInfo({ ...item, version })}>i</button><button className="remove-package" title={`Remove ${item.title}`} onClick={() => void removePackage(item)}>×</button></div>;
  }

  return <div className={`app-shell ${workspaceView === "registry" ? "registry-mode" : ""}`}>
    <header className="topbar">
      <div className="brand"><img src="./studio-mark.svg" alt=""/><div><strong>BioLang Studio</strong><small>learn · analyse · reproduce</small></div></div>
      <nav className="workspace-tabs" aria-label="Studio workspace">
        <button className={workspaceView === "notebook" ? "active" : ""} onClick={() => navigateWorkspace("notebook")}>Notebook</button>
        <button className={workspaceView === "registry" ? "active" : ""} onClick={() => navigateWorkspace("registry")}>Registry</button>
      </nav>
      <nav className="toolbar">
        {workspaceView === "notebook" && <button onClick={() => setStatisticsGuideOpen(true)}>Guided stats</button>}
        {workspaceView === "notebook" ? <><button onClick={newNotebook}>New</button><button onClick={openFile}>Open</button><button onClick={saveFile}>Save</button><button onClick={() => setExportOpen(true)}>Export</button>{nativeDocumentsAvailable() && <button onClick={() => void saveDesktopNotebook(true)}>Save as…</button>}<details className="workspace-file-menu"><summary>Workspace{workspaceDirty ? " ●" : ""}</summary><div><button onClick={event => { openWorkspace(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Open .blw</button><button onClick={event => { saveWorkspaceFile(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{nativeDocumentsAvailable() ? "Save .blw" : "Export .blw"}</button>{nativeDocumentsAvailable() && <button onClick={event => { saveWorkspaceFile(true); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Save .blw as…</button>}<button disabled={!activeDocument.lastRun} onClick={event => { saveRunRecord(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Export latest run record</button>{recentNativeDocuments.length > 0 && <div className="recent-native"><small>Recent Desktop files</small>{recentNativeDocuments.map(recent => <button key={recent.path} title={recent.path} onClick={event => { openRecentDocument(recent); event.currentTarget.closest("details")?.removeAttribute("open"); }}><span>{recent.filename}</span><em>{recent.kind}</em></button>)}</div>}</div></details>
          <button className="primary" disabled={running || codeCount === 0 || kernelState !== "ready"} title={kernelState !== "ready" ? "BioLang is still starting" : codeLanguage === "javascript" ? "Compile the displayed JavaScript frontend to BioLang and run it" : "Run the BioLang cells"} onClick={() => pendingLessonData.length ? void prepareAndRunAll() : void runTo(cells.length - 1, true)}>▶ {pendingLessonData.length ? "Prepare & run all" : "Run all"} · {codeLanguage === "javascript" ? "JS" : "BL"}</button>
          {running && <button onClick={() => void stopRun()}>Stop</button>}</> : <button onClick={() => void refreshRegistry()}>Refresh registry</button>}
      </nav>
      <div className="kernel-switch">
        {workspaceView === "notebook" && <label>Code<select className="code-language-select" aria-label="Notebook code language" value={codeLanguage} disabled={running} onChange={event => setCodeLanguage(event.target.value as NotebookCodeLanguage)}><option value="biolang">BioLang</option><option value="javascript">JavaScript</option></select></label>}
        <label>Theme<select className="theme-select" aria-label="Color theme" value={colorTheme} onChange={event => setColorTheme(event.target.value as StudioTheme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>Kernel<select aria-label="Kernel" value={kernelKind} disabled={running} onChange={event => {
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
      <section><div className="section-head"><h2>Installed lessons <small>{catalog.length}</small></h2><button title="Add lesson package" onClick={() => setPackageOpen(true)}>＋</button></div>{catalog.length ? <div className="installed-lesson-list">
        {lessonSeries.groups.map(group => <details className="lesson-series" open key={group.id}><summary><strong>{group.title}</strong><small>{group.items.length}</small></summary><div className="lesson-series-head"><span>Book series</span><a href={group.url} target="_blank" rel="noreferrer">Source ↗</a></div>{group.items.map(renderInstalledLesson)}</details>)}
        {lessonSeries.standalone.map(renderInstalledLesson)}
      </div> : <div className="empty-catalog"><p>No lesson packages installed.</p><button onClick={() => setPackageOpen(true)}>Add from manifest URL</button></div>}</section>
      <section><h2>Data <small>{(lesson?.datasets.length ?? 0) + visibleUserAttachments.length}</small></h2><div className="sidebar-data-list">{lesson ? lesson.datasets.map(dataset => <div className={`dataset ${dataReady[dataset.id] ? "ready" : "needs-prepare"}`} key={dataset.id}><div><strong>{dataset.title}</strong><span>{dataReady[dataset.id] ? `${displayBytes(dataset.bytes)} · ready` : `${displayBytes(dataset.bytes)} · not prepared`}</span></div><button disabled={dataReady[dataset.id]} onClick={() => void prepare(dataset.id)}>{dataReady[dataset.id] ? "Ready" : progress[dataset.id] ? `${Math.round(progress[dataset.id] / dataset.bytes * 100)}%` : "Prepare"}</button></div>) : <p className="muted">A lesson can declare the exact data it needs.</p>}
        {visibleUserAttachments.map(attachment => <div className={`attached-data ${missingAttachmentIds.has(attachment.id) ? "missing" : ""}`} key={attachment.id}><div><strong>{attachment.path}</strong><span title={attachment.source.kind === "url" ? attachment.source.url : attachment.source.kind === "output" ? `Published from ${attachment.source.producerNotebookFilename}: ${attachment.source.variable}` : undefined}>{missingAttachmentIds.has(attachment.id) ? "needs data · " : `${displayBytes(attachment.size)} · `}{attachment.scope.kind === "workspace" ? "all notebooks" : "this notebook"}{attachment.source.kind === "url" ? " · HTTPS source" : attachment.source.kind === "output" ? ` · output from ${attachment.source.producerNotebookFilename}` : ""}</span></div>{missingAttachmentIds.has(attachment.id) && <button onClick={() => void prepareReferencedAttachment(attachment)}>{attachment.source.kind === "local" || attachment.source.kind === "output" ? "Reattach" : "Prepare"}</button>}<button onClick={() => changeAttachmentScope(attachment)}>{attachment.scope.kind === "workspace" ? "Keep here" : "Share"}</button><button aria-label={`Detach ${attachment.path}`} title="Detach without deleting cached source data" onClick={() => removeAttachmentFromWorkspace(attachment)}>×</button></div>)}
        </div><div className="data-actions"><button onClick={() => {
          if (kernelKind === "desktop") void attachNativeFiles().catch(error => setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) }));
          else { reattachTargetRef.current = null; fileInput.current?.click(); }
        }}>Attach local</button><button onClick={() => { setUrlDataReview(false); setUrlDataError(""); setUrlDataOpen(true); }}>From URL…</button></div>
        {kernelKind === "browser" && <details className="runtime-handoff"><summary>Need larger or protected data?</summary><p>Keep the notebook and move only its execution when browser limits are unsuitable.</p><div>{desktopAvailable() && <button onClick={useDesktopKernel}>Use Desktop</button>}<button onClick={useSomerKernel}>Use SOMER…</button></div></details>}
      </section>
      <section className="variables-section"><VariableInspector variables={variables} revision={variableRevision} canInspect={kernelRef.current?.capabilities.variableInspection ?? false} exportMode={kernelRef.current?.capabilities.variableExport ?? "none"} canRemove={kernelRef.current?.capabilities.variableRemoval ?? false} inspect={(name, offset, limit) => kernelRef.current!.inspectVariable(name, offset, limit)} exportExact={(name, format, maximumBytes) => kernelRef.current!.exportVariable(name, format, maximumBytes)} publishOutput={publishWorkspaceOutput} notify={setNotice}/></section>
      <section className="storage-section"><details className={`storage-disclosure ${localStorageStatus.quota && localStorageStatus.usage / localStorageStatus.quota >= .8 ? "warning" : ""}`}><summary><span>Local storage</span><small>{displayBytes(localStorageStatus.usage)}</small></summary><div className="storage-meter" role="meter" aria-label="Browser storage used" aria-valuemin={0} aria-valuemax={localStorageStatus.quota || 1} aria-valuenow={localStorageStatus.usage}><i style={{ width: `${localStorageStatus.quota ? Math.min(100, localStorageStatus.usage / localStorageStatus.quota * 100) : 0}%` }}/></div><p className="muted">{displayBytes(localStorageStatus.usage)} used{localStorageStatus.quota ? ` of ${displayBytes(localStorageStatus.quota)}` : ""} · {localStorageStatus.persistent ? "protected from automatic eviction" : "browser-managed"}</p><div><button onClick={() => void refreshStorageStatus()}>Refresh</button>{!localStorageStatus.persistent && <button onClick={() => void protectLocalStorage()}>Protect</button>}<button className="danger" onClick={() => void clearCachedWorkspaceData()}>Clear cached data</button></div></details></section>
    </aside>}
    {workspaceView === "notebook" ? <main>
      <div className="document-tabs"><input aria-label="Workspace name" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} /><div role="tablist" aria-label="Open notebooks">{documentTabGroups.map(group => {
        const active = group.documents.some(document => document.id === activeDocumentId);
        const dirty = group.documents.some(document => document.dirty);
        return <div className={`document-tab ${group.collection ? "collection" : ""} ${active ? "active" : ""}`} key={group.key}><button role="tab" aria-selected={active} onClick={() => switchDocumentGroup(group)}><span>{group.label}</span>{group.collection && <b title={`${group.documents.length} lesson sections`}>{group.documents.length}</b>}{dirty && <i title="Unsaved changes">●</i>}</button><button aria-label={`Close ${group.label}`} onClick={() => closeDocumentGroup(group)}>×</button></div>;
      })}</div><button title="New notebook" aria-label="New notebook" onClick={newNotebook}>＋</button>{lastClosed && <button className="reopen-tab" onClick={reopenNotebook}>Reopen closed</button>}</div>
      <div className="document-head"><div>{activeCollectionEntry ? <div className="collection-heading"><span className="collection-eyebrow">{lesson!.title}</span><div><button aria-label="Previous lesson section" title="Previous section" disabled={activeCollectionIndex <= 0 || running} onClick={() => switchLessonSection(activeCollectionEntries[activeCollectionIndex - 1].id)}>←</button><label><span>Section {activeCollectionIndex + 1} of {activeCollectionEntries.length}</span><select aria-label="Lesson section" value={activeCollectionEntry.id} disabled={running} onChange={event => switchLessonSection(event.target.value)}>{activeCollectionEntries.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label><button aria-label="Next lesson section" title="Next section" disabled={activeCollectionIndex >= activeCollectionEntries.length - 1 || running} onClick={() => switchLessonSection(activeCollectionEntries[activeCollectionIndex + 1].id)}>→</button></div><small>{activeCollectionEntry.summary}</small></div> : <><input aria-label="Notebook name" value={filename} onChange={event => setFilename(event.target.value)} /><span>{cells.length} cells · {codeCount} runnable{codeCount ? ` · ${currentCodeCount === codeCount ? "all current" : `${currentCodeCount} current`}` : ""}</span></>}</div>{lesson && <div className="document-provenance">
        {previousSeriesLesson && <button title={previousSeriesLesson.title} onClick={() => void openInstalledLesson(previousSeriesLesson)}>← Previous chapter</button>}
        {nextSeriesLesson && <button title={nextSeriesLesson.title} onClick={() => void openInstalledLesson(nextSeriesLesson)}>Next chapter →</button>}
        <details className="notebook-provenance"><summary>Provenance</summary><div><dl>
          <div><dt>Source</dt><dd><a href={lesson.source.url} target="_blank" rel="noreferrer">{lesson.source.title} ↗</a></dd></div>
          <div><dt>Lesson</dt><dd>{activeInstalledLesson?.version ? `v${activeInstalledLesson.version}` : "custom"}{activeDocument.dirty ? " · locally modified" : " · original source"}</dd></div>
          {activeRegistryLesson && <><div><dt>Licence</dt><dd>{activeRegistryLesson.licence}</dd></div><div><dt>Validation</dt><dd>{activeRegistryLesson.validation}</dd></div></>}
          <div><dt>Manifest SHA-256</dt><dd><code>{activeDocument.lessonManifestSha256 ?? activeInstalledLesson?.manifestSha256 ?? "Not recorded"}</code></dd></div>
          <div><dt>Declared data</dt><dd>{lesson.datasets.length ? `${lesson.datasets.length} checksum-pinned file${lesson.datasets.length === 1 ? "" : "s"}` : "None"}</dd></div>
          <div><dt>Latest run</dt><dd>{activeDocument.lastRun ? `${activeDocument.lastRun.success ? "Successful" : "Failed"} · ${activeDocument.lastRun.notebook.sourceLanguage === "javascript" ? "JavaScript → BioLang" : "BioLang"} · ${activeDocument.lastRun.runtime.runtime} · ${activeDocument.lastRun.finishedAt}` : "Not run in this workspace"}</dd></div>
        </dl>{lesson.datasets.length > 0 && <details><summary>Dataset checksums</summary>{lesson.datasets.map(dataset => <code key={dataset.id}>{dataset.path} · {dataset.sha256}</code>)}</details>}</div></details>
        <details className="notebook-share"><summary>Share…</summary><div>{activeRegistryLesson && <button onClick={() => void copyCatalogueLink(activeRegistryLesson)}>Copy catalogue link</button>}<button onClick={() => void shareActiveLesson()}>Copy Studio link</button>{activeRegistryLesson && <button onClick={() => void copyChecksumLessonLink(activeRegistryLesson)}>Copy checksum link</button>}</div></details><button title="Replace edited cells and outputs with the lesson package version; prepared data is kept" onClick={() => void restoreOriginalLesson()}>Restore original</button>
      </div>}</div>
      {notice && <div className={`notice notice-${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"} aria-live={notice.tone === "bad" ? "assertive" : "polite"}><span>{notice.text}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      {(notebookChangedExternally || workspaceChangedExternally) && <div className="external-change" role="alert"><div><strong>Changed outside Studio</strong><span>Reload the disk version, or Save and explicitly confirm an overwrite.</span></div>{notebookChangedExternally && activeDocument.nativeFile && <button onClick={() => void openDesktopNotebook(activeDocument.nativeFile!.path, true)}>Reload notebook</button>}{workspaceChangedExternally && workspaceNativeFile && <button onClick={() => void openDesktopWorkspace(workspaceNativeFile.path, true)}>Reload workspace</button>}</div>}
      <div className="cells">{pendingLessonData.length > 0 && <div className="data-preflight" role="alert"><div><strong>Prepare data before running</strong><span>This lesson needs {pendingLessonData.length} file{pendingLessonData.length === 1 ? "" : "s"}. Browser BioLang can only open them after they are downloaded, verified, and attached.</span></div><button className="primary" onClick={() => void prepareAllLessonData()}>Prepare {pendingLessonData.length === 1 ? "data" : `all ${pendingLessonData.length} files`}</button></div>}{displayBlocks.map(block => block.step ? <section className={`lesson-step ${collapsedSteps.has(block.step.id) ? "collapsed" : ""}`} key={block.key}>
        <header className="lesson-step-head"><div><span>Lesson step</span><strong>{block.step.title || "Untitled step"}</strong><small>{block.items.filter(item => item.cell.type === "code").length} runnable</small></div><div><button disabled={running || !block.items.some(item => item.cell.type === "code")} onClick={() => void runTo(block.items.at(-1)!.index)}>▶ Run step</button><button onClick={() => editStep(block.items)}>Edit source</button><button aria-label={`${collapsedSteps.has(block.step.id) ? "Expand" : "Collapse"} ${block.step.title || "lesson step"}`} onClick={() => setCollapsedSteps(current => { const next = new Set(current); if (next.has(block.step!.id)) next.delete(block.step!.id); else next.add(block.step!.id); return next; })}>{collapsedSteps.has(block.step.id) ? "▸" : "▾"}</button></div></header>
        {!collapsedSteps.has(block.step.id) && <div className="lesson-step-cells">{block.items.map(({ cell, index }) => renderCell(cell, index))}</div>}
      </section> : block.items.map(({ cell, index }) => renderCell(cell, index)))}</div>
      <div className="add-cells"><button onClick={() => addCell("code")}>+ Code</button><button onClick={() => addCell("markdown")}>+ Explanation</button><button onClick={addStep}>+ Step</button></div>
    </main> : <RegistryWorkspace entries={registryEntries} source={registrySource} checkedAt={registryCheckedAt} error={registryError} filters={registryFilters} selectedKey={selectedRegistryKey} installedLessons={installedLessonKeys} outdatedLessons={outdatedLessonKeys} openLessons={openLessonKeys} modifiedLessons={modifiedLessonKeys} preparedDatasets={preparedRegistryDatasets} installingId={installingId} datasetDetails={registryDatasetDetails} detailLoading={registryDetailLoading} detailError={registryDetailError} notice={notice} onDismissNotice={() => setNotice(null)} onFiltersChange={updateRegistryFilters} onSelect={selectRegistryEntry} onRefresh={() => void refreshRegistry()} onInstall={installOrReviewRegistryEntry} onOpenLesson={entry => void openRegistryLesson(entry)} onShareLesson={entry => void copyLessonLink(entry)} onCopyCatalogueLink={entry => void copyCatalogueLink(entry)} onCopyChecksumLink={entry => void copyChecksumLessonLink(entry)} onPrepare={(entry, details) => void prepareRegistryDataset(entry, details)} onCopyCommand={entry => void copyRegistryCommand(entry)}/>}
    <input hidden ref={fileInput} type="file" multiple onChange={event => { const input = event.currentTarget; void attachFiles(input.files).catch(error => setNotice({ tone: "bad", text: error.message })).finally(() => { input.value = ""; }); }}/>
    <input hidden ref={notebookInput} type="file" accept=".bln,.md,.bl.md" onChange={event => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; void openBrowserFile(file); }}/>
    <input hidden ref={workspaceInput} type="file" accept=".blw,application/json" onChange={event => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; void openWorkspaceFile(file).catch(error => setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) })); }}/>
    {remoteOpen && <DialogShell label="Connect to SOMER" close={() => setRemoteOpen(false)}><form className="modal" onSubmit={event => { event.preventDefault(); setKernelKind("somer"); setRemoteOpen(false); }}><h2>Connect to SOMER</h2><p>The token stays in memory and is never saved by Studio.</p><label>Server URL<input autoFocus required type="url" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://compute.example.org" /></label><label>Bearer token<input required type="password" value={remoteToken} onChange={event => setRemoteToken(event.target.value)} /></label><div><button type="button" onClick={() => setRemoteOpen(false)}>Cancel</button><button className="primary" type="submit">Connect</button></div></form></DialogShell>}
    {packageOpen && <DialogShell label="Add a lesson package" close={() => setPackageOpen(false)}><form className="modal" onSubmit={event => { event.preventDefault(); void addPackage(); }}><h2>Add a lesson package</h2><p>Paste an HTTPS lesson manifest URL, or an HTTP localhost URL while developing locally. Custom manifests are validated and pinned to the checksum Studio observes. Declared datasets are downloaded separately only when you choose Prepare.</p><label>Manifest URL<input autoFocus required type="url" value={packageUrl} onChange={event => setPackageUrl(event.target.value)} placeholder="https://example.org/lesson.json" /></label><div><button type="button" onClick={() => setPackageOpen(false)}>Cancel</button><button className="primary" type="submit">Add lesson</button></div></form></DialogShell>}
    {lessonInfo && <DialogShell label={`About ${lessonInfo.title}`} close={() => setLessonInfo(null)}><section className="modal lesson-info-modal"><span className="modal-eyebrow">Installed lesson</span><h2>{lessonInfo.title}</h2><p>{lessonInfo.summary || "No short description was supplied."}</p><dl><div><dt>Version</dt><dd>{lessonInfo.version ? `v${lessonInfo.version}` : "Custom or legacy install"}</dd></div><div><dt>Runtime</dt><dd>{lessonInfo.runtime}</dd></div>{lessonInfo.series && <><div><dt>Book</dt><dd><a href={lessonInfo.series.url} target="_blank" rel="noreferrer">{lessonInfo.series.title} ↗</a></dd></div><div><dt>Chapter</dt><dd>{lessonInfo.series.chapter}</dd></div></>}</dl>{lessonInfo.tags.length > 0 && <div className="lesson-info-tags">{lessonInfo.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}<div><button onClick={() => setLessonInfo(null)}>Close</button><button className="primary" onClick={() => { const selected = lessonInfo; setLessonInfo(null); void openInstalledLesson(selected); }}>Open lesson</button></div></section></DialogShell>}
    {statisticsGuideOpen && <StatisticsGuideDialog close={() => setStatisticsGuideOpen(false)} create={createGuidedStatisticsNotebook}/>}
    {exportOpen && <ExportNotebookDialog issues={exportIssues} busy={exportBusy} close={() => setExportOpen(false)} submit={(format, options) => void exportNotebook(format, options)}/>}
    {(lessonLaunchRequest || lessonLaunchError) && <LessonLaunchDialog request={lessonLaunchRequest} review={lessonLaunchReview} loading={lessonLaunchLoading} error={lessonLaunchError} busy={lessonLaunchBusy} runtimeCompatible={lessonLaunchRuntimeCompatible} close={closeLessonLaunch} install={runAll => void installSharedLesson(runAll)}/>}
    {lessonUpdateEntry && lessonUpdateInstalled && <LessonUpdateDialog installed={lessonUpdateInstalled} update={lessonUpdateEntry} busy={installingId === lessonUpdateEntry.id} close={() => setLessonUpdateEntry(null)} confirm={() => void confirmLessonUpdate()}/>}
    {urlDataOpen && <DialogShell label={urlDataReview ? "Review remote data" : "Add data from URL"} close={closeUrlData}><form className="modal url-data-modal" onSubmit={event => { event.preventDefault(); if (urlDataReview) void downloadUrlData(); else reviewUrlData(); }}>
      <h2>{urlDataReview ? "Review remote data" : "Add data from URL"}</h2>
      {urlDataError && <p className="url-data-error" role="alert">{urlDataError}</p>}
      {!urlDataReview ? <>
        <p>Studio downloads only after review. The URL and observed checksum are saved as workspace provenance. Do not use secret or credential-bearing URLs.</p>
        <label>HTTPS source URL<input autoFocus required type="url" value={urlDataDraft.url} onChange={event => setUrlDataDraft(current => {
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
    </form></DialogShell>}
  </div>;
}
