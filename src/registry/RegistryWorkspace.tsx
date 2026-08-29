import { useEffect, useMemo } from "react";
import {
  DEFAULT_REGISTRY_URL,
  filterRegistry,
  type RegisteredDatasetManifest,
  type RegistryAccessFilter,
  type RegistryEntry,
  type RegistryFilters,
  type RegistryKindFilter,
  type RegistrySort,
  type RegistrySource,
  type RegistryVerificationFilter,
} from "../content/registry";

const KINDS: Array<{ value: RegistryKindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "lesson", label: "Lessons" },
  { value: "dataset", label: "Datasets" },
  { value: "workflow", label: "Workflows" },
  { value: "package", label: "Packages" },
  { value: "tool", label: "Tools" },
  { value: "provider", label: "Providers" },
];

export interface RegistryViewState {
  query: string;
  kind: RegistryKindFilter;
  category: string;
  runtime: string;
  access: RegistryAccessFilter;
  verification: RegistryVerificationFilter;
  sort: RegistrySort;
}

interface RegistryWorkspaceProps {
  entries: RegistryEntry[];
  source: RegistrySource | "loading" | "unavailable";
  error: string;
  filters: RegistryViewState;
  selectedKey: string;
  installedLessons: Set<string>;
  preparedDatasets: Set<string>;
  installingId: string;
  datasetDetails: RegisteredDatasetManifest | null;
  detailLoading: boolean;
  detailError: string;
  notice?: { tone: "info" | "good" | "bad"; text: string } | null;
  onFiltersChange: (patch: Partial<RegistryViewState>) => void;
  onSelect: (entry: RegistryEntry) => void;
  onRefresh: () => void;
  onInstall: (entry: RegistryEntry) => void;
  onOpenLesson: (entry: RegistryEntry) => void;
  onPrepare: (entry: RegistryEntry, details?: RegisteredDatasetManifest) => void;
  onCopyCommand: (entry: RegistryEntry) => void;
}

function entryKey(entry: RegistryEntry) {
  return `${entry.id}@${entry.version}`;
}

function displayBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function sourceLabel(source: RegistryWorkspaceProps["source"]) {
  if (source === "local") return "local registry";
  if (source === "network") return "registry.lang.bio";
  if (source === "fallback") return "GitHub fallback";
  if (source === "cache") return "offline cache";
  return source;
}

function EntryBadges({ entry, installed, prepared }: { entry: RegistryEntry; installed: boolean; prepared: boolean }) {
  return <div className="registry-badges">
    <span className={`trust-badge ${entry.verified ? "verified" : "preview"}`}>{entry.verified ? "Verified" : entry.status}</span>
    {entry.compatibility.runtimes.includes("browser") && <span className="compat-badge">Browser</span>}
    {installed && <span className="state-badge">Installed</span>}
    {prepared && <span className="state-badge">Cached</span>}
  </div>;
}

export function RegistryWorkspace(props: RegistryWorkspaceProps) {
  const categories = useMemo(() => [...new Set(props.entries.flatMap(entry => entry.categories))].sort(), [props.entries]);
  const runtimes = useMemo(() => [...new Set(props.entries.flatMap(entry => entry.compatibility.runtimes))].sort(), [props.entries]);
  const visible = useMemo(() => filterRegistry(props.entries, props.filters as RegistryFilters), [props.entries, props.filters]);
  const selected = props.entries.find(entry => entryKey(entry) === props.selectedKey) ?? null;

  useEffect(() => {
    if (visible.length && !visible.some(entry => entryKey(entry) === props.selectedKey)) props.onSelect(visible[0]);
  }, [visible, props.selectedKey, props.onSelect]);

  const activeFilterCount = [props.filters.category, props.filters.runtime,
    props.filters.access !== "all" ? props.filters.access : "",
    props.filters.verification !== "all" ? props.filters.verification : ""].filter(Boolean).length;

  return <main className="registry-main">
    <section className="registry-hero">
      <div>
        <span className="eyebrow">Verified, on-demand BioLang content</span>
        <h1>Registry</h1>
        <p>Find lessons, datasets and tools. Nothing is installed or downloaded until you choose it.</p>
      </div>
      <div className="registry-connection">
        <a href={DEFAULT_REGISTRY_URL} target="_blank" rel="noreferrer">Open index</a>
        <span className={`connection-dot ${props.source === "unavailable" ? "offline" : ""}`}/>
        <strong>{sourceLabel(props.source)}</strong>
        <button onClick={props.onRefresh} disabled={props.source === "loading"}>Refresh</button>
      </div>
    </section>

    {props.notice && <div className={`notice notice-${props.notice.tone}`}>{props.notice.text}</div>}
    {props.source === "unavailable" && <div className="registry-alert"><strong>Registry unavailable</strong><span>{props.error || "Installed lessons and local notebooks remain available."}</span></div>}

    <section className="registry-controls" aria-label="Registry filters">
      <label className="registry-search"><span>Search</span><input aria-label="Registry search" value={props.filters.query} onChange={event => props.onFiltersChange({ query: event.target.value })} placeholder="Try single-cell, Homo sapiens, CSV, or statistics"/></label>
      <div className="registry-kind-tabs" role="tablist" aria-label="Registry content type">
        {KINDS.map(kind => <button key={kind.value} role="tab" aria-selected={props.filters.kind === kind.value} className={props.filters.kind === kind.value ? "active" : ""} onClick={() => props.onFiltersChange({ kind: kind.value })}>
          {kind.label}<span>{props.entries.filter(entry => kind.value === "all" || entry.kind === kind.value).length}</span>
        </button>)}
      </div>
      <div className="registry-filter-grid">
        <label>Category<select aria-label="Registry category" value={props.filters.category} onChange={event => props.onFiltersChange({ category: event.target.value })}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Runtime<select aria-label="Registry runtime" value={props.filters.runtime} onChange={event => props.onFiltersChange({ runtime: event.target.value })}><option value="">Any runtime</option>{runtimes.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Access<select aria-label="Registry access" value={props.filters.access} onChange={event => props.onFiltersChange({ access: event.target.value as RegistryAccessFilter })}><option value="all">Any access</option><option value="public">Public</option><option value="registration">Registration</option><option value="controlled">Controlled</option></select></label>
        <label>Trust<select aria-label="Registry verification" value={props.filters.verification} onChange={event => props.onFiltersChange({ verification: event.target.value as RegistryVerificationFilter })}><option value="all">Any status</option><option value="verified">Verified</option><option value="preview">Preview</option></select></label>
        <label>Sort<select aria-label="Registry sort" value={props.filters.sort} onChange={event => props.onFiltersChange({ sort: event.target.value as RegistrySort })}><option value="relevance">Best match</option><option value="recent">Recently published</option><option value="name">Name</option><option value="size">Dataset size</option></select></label>
        <button className="clear-filters" disabled={!activeFilterCount} onClick={() => props.onFiltersChange({ category: "", runtime: "", access: "all", verification: "all" })}>Clear {activeFilterCount ? `(${activeFilterCount})` : ""}</button>
      </div>
    </section>

    <div className="registry-browser">
      <section className="registry-results" aria-label="Registry results">
        <div className="results-heading"><strong>{visible.length} result{visible.length === 1 ? "" : "s"}</strong><span>{props.filters.query ? `for “${props.filters.query}”` : "from the public registry"}</span></div>
        {props.source === "loading" ? <div className="registry-empty"><strong>Loading the registry…</strong></div> : visible.length ? visible.map(entry => {
          const installed = entry.kind === "lesson" && props.installedLessons.has(entry.name);
          const prepared = entry.kind === "dataset" && props.preparedDatasets.has(entry.id);
          return <button className={`registry-result-card ${entryKey(entry) === props.selectedKey ? "selected" : ""}`} key={entryKey(entry)} onClick={() => props.onSelect(entry)}>
            <div className="result-card-top"><span className="kind-label">{entry.kind}</span><EntryBadges entry={entry} installed={installed} prepared={prepared}/></div>
            <h2>{entry.title}</h2><p>{entry.summary}</p>
            <div className="result-card-tags">{entry.categories.map(category => <span key={category}>{category}</span>)}</div>
            <div className="result-card-foot"><span>{entry.publisher} / {entry.name}</span><span>v{entry.version}</span>{entry.dataset && <span>{displayBytes(entry.dataset.totalBytes)}</span>}</div>
          </button>;
        }) : <div className="registry-empty"><strong>No matching entries</strong><span>Try fewer words or clear one of the filters.</span></div>}
      </section>

      <aside className="registry-detail" aria-label="Registry entry details">
        {selected ? <RegistryDetail entry={selected} installed={selected.kind === "lesson" && props.installedLessons.has(selected.name)} prepared={selected.kind === "dataset" && props.preparedDatasets.has(selected.id)} installing={props.installingId === selected.id} details={props.datasetDetails} detailLoading={props.detailLoading} detailError={props.detailError} onInstall={props.onInstall} onOpenLesson={props.onOpenLesson} onPrepare={props.onPrepare} onCopyCommand={props.onCopyCommand}/> : <div className="registry-empty"><strong>Select an entry</strong><span>Its compatibility, provenance and actions will appear here.</span></div>}
      </aside>
    </div>
  </main>;
}

interface RegistryDetailProps {
  entry: RegistryEntry;
  installed: boolean;
  prepared: boolean;
  installing: boolean;
  details: RegisteredDatasetManifest | null;
  detailLoading: boolean;
  detailError: string;
  onInstall: (entry: RegistryEntry) => void;
  onOpenLesson: (entry: RegistryEntry) => void;
  onPrepare: (entry: RegistryEntry, details?: RegisteredDatasetManifest) => void;
  onCopyCommand: (entry: RegistryEntry) => void;
}

function RegistryDetail({ entry, installed, prepared, installing, details, detailLoading, detailError, onInstall, onOpenLesson, onPrepare, onCopyCommand }: RegistryDetailProps) {
  const browserReady = entry.compatibility.runtimes.includes("browser") && entry.dataset?.access !== "controlled" && (entry.dataset?.totalBytes ?? 0) <= 50 * 1024 ** 2;
  return <div className="detail-card">
    <div className="detail-heading"><span className="kind-label">{entry.kind}</span><EntryBadges entry={entry} installed={installed} prepared={prepared}/><h2>{entry.title}</h2><code>{entry.id}@{entry.version}</code><p>{details?.description || entry.summary}</p></div>

    <div className="detail-actions">
      {entry.kind === "lesson" && (installed ? <button className="primary-action" aria-label={`Open ${entry.title}`} onClick={() => onOpenLesson(entry)}>Open lesson</button> : <button className="primary-action" aria-label={`Install ${entry.title}`} disabled={installing} onClick={() => onInstall(entry)}>{installing ? "Verifying…" : "Install and open"}</button>)}
      {entry.kind === "dataset" && <>
        <button className="primary-action" aria-label={`Prepare ${entry.title}`} disabled={installing || prepared || !browserReady} title={!browserReady ? "Use the BioLang CLI, Desktop, or SOMER for this dataset" : ""} onClick={() => onPrepare(entry, details ?? undefined)}>{prepared ? "Prepared" : installing ? "Verifying…" : "Prepare in browser"}</button>
        <button onClick={() => onCopyCommand(entry)}>Copy CLI command</button>
      </>}
      {entry.kind === "provider" && entry.provider && <a className="button-link primary-action" href={entry.provider.apiDocumentation} target="_blank" rel="noreferrer">Open API docs</a>}
    </div>
    {entry.kind === "dataset" && !browserReady && <p className="runtime-guidance">This entry is too large, binary, or access-controlled for browser preparation. Use the copied CLI command, Desktop, or SOMER.</p>}

    <dl className="detail-facts">
      <div><dt>Publisher</dt><dd>{entry.publisher}</dd></div><div><dt>Published</dt><dd>{entry.publishedAt}</dd></div>
      <div><dt>Licence</dt><dd>{entry.licence}</dd></div><div><dt>Validation</dt><dd>{entry.validation}</dd></div>
      {entry.dataset && <><div><dt>Access</dt><dd>{entry.dataset.access}</dd></div><div><dt>Size</dt><dd>{displayBytes(entry.dataset.totalBytes)} · {entry.dataset.fileCount} file{entry.dataset.fileCount === 1 ? "" : "s"}</dd></div></>}
      {entry.provider && <><div><dt>Authentication</dt><dd>{entry.provider.authentication}</dd></div><div><dt>Adapter</dt><dd>{entry.provider.adapter}</dd></div></>}
    </dl>

    <DetailGroup title="Runs with" values={entry.compatibility.runtimes}/>
    <DetailGroup title="Categories" values={entry.categories}/>
    {!!entry.tags.length && <DetailGroup title="Tags" values={entry.tags}/>} 
    {entry.dataset && <>
      <DetailGroup title="Formats" values={entry.dataset.formats}/><DetailGroup title="Modalities" values={entry.dataset.modalities}/><DetailGroup title="Organisms" values={entry.dataset.organisms}/>
    </>}
    {entry.provider && <DetailGroup title="Capabilities" values={entry.provider.capabilities}/>} 

    {entry.kind === "dataset" && <section className="manifest-details"><h3>Declared files</h3>{detailLoading ? <p>Verifying manifest…</p> : detailError ? <p className="detail-error">{detailError}</p> : details ? <>
      <div className="file-list">{details.files.map(file => <div key={file.id}><div><strong>{file.title}</strong><code>{file.path}</code></div><span>{file.format} · {displayBytes(file.bytes)}<br/>{file.reader}()</span></div>)}</div>
      <h3>Source and rights</h3><p>{details.source.citation}</p><p>{details.source.rights}</p><a href={details.source.landingPage} target="_blank" rel="noreferrer">Open source record</a>
    </> : null}</section>}

    <div className="detail-links"><a href={entry.sourceRepository} target="_blank" rel="noreferrer">Source repository</a><a href={entry.manifest} target="_blank" rel="noreferrer">Manifest</a></div>
    <details className="integrity-details"><summary>Integrity information</summary><code>{entry.manifestSha256}</code><p>The manifest is verified before Studio reads it. Declared files are verified again after download.</p></details>
  </div>;
}

function DetailGroup({ title, values }: { title: string; values: string[] }) {
  if (!values.length) return null;
  return <section className="detail-group"><h3>{title}</h3><div>{values.map(value => <span key={value}>{value}</span>)}</div></section>;
}
