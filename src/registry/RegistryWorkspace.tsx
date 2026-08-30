import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_REGISTRY_URL,
  filterRegistry,
  publicRegistryUrl,
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
  checkedAt: string;
  error: string;
  filters: RegistryViewState;
  selectedKey: string;
  installedLessons: Set<string>;
  outdatedLessons: Set<string>;
  openLessons: Set<string>;
  modifiedLessons: Set<string>;
  preparedDatasets: Set<string>;
  installingId: string;
  datasetDetails: RegisteredDatasetManifest | null;
  detailLoading: boolean;
  detailError: string;
  notice?: { tone: "info" | "good" | "bad"; text: string } | null;
  onDismissNotice: () => void;
  onFiltersChange: (patch: Partial<RegistryViewState>) => void;
  onSelect: (entry: RegistryEntry | null) => void;
  onRefresh: () => void;
  onInstall: (entry: RegistryEntry) => void;
  onOpenLesson: (entry: RegistryEntry) => void;
  onShareLesson: (entry: RegistryEntry) => void;
  onCopyCatalogueLink: (entry: RegistryEntry) => void;
  onCopyChecksumLink: (entry: RegistryEntry) => void;
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

function checkedLabel(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "previously";
}

function EntryBadges({ entry, installed, outdated, opened, modified, prepared }: { entry: RegistryEntry; installed: boolean; outdated: boolean; opened: boolean; modified: boolean; prepared: boolean }) {
  return <div className="registry-badges">
    <span className="integrity-badge" title="The registry pins this manifest to an exact SHA-256 checksum">Checksum pinned</span>
    <span className={`trust-badge ${entry.verified ? "verified" : "unverified"}`} title={entry.verified ? "The registry has verified this publisher entry" : "The manifest is checksum-protected, but publisher verification has not been granted"}>{entry.verified ? "Publisher verified" : "Publisher unverified"}</span>
    <span className={`status-badge status-${entry.status}`}>{entry.status}</span>
    {entry.compatibility.runtimes.includes("browser") && <span className="compat-badge">Browser</span>}
    {entry.kind === "lesson" && !installed && <span className="state-badge available">Available</span>}
    {installed && <span className="state-badge installed">Installed</span>}
    {opened && <span className="state-badge open">Open</span>}
    {modified && <span className="state-badge modified">Locally modified</span>}
    {outdated && <span className="state-badge update">Update available</span>}
    {prepared && <span className="state-badge">Cached</span>}
  </div>;
}

interface RegistryLessonGroup {
  id: string;
  title: string;
  url: string;
  entries: RegistryEntry[];
}

function RegistrySeriesGroup({ group, selectedKey, children }: { group: RegistryLessonGroup; selectedKey: string; children: ReactNode }) {
  const containsSelection = group.entries.some(entry => entryKey(entry) === selectedKey);
  const [open, setOpen] = useState(containsSelection);
  useEffect(() => { if (containsSelection) setOpen(true); }, [containsSelection]);
  return <details className="registry-series" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span><strong>{group.title}</strong><small>{group.entries.length} lesson{group.entries.length === 1 ? "" : "s"}</small></span><em><span className="series-collapsed-label">View collection</span><span className="series-expanded-label">Hide collection</span></em></summary>
    <div className="registry-series-head"><span>Book or course collection</span><a href={group.url} target="_blank" rel="noreferrer">Source ↗</a></div>
    <div className="registry-series-results">{children}</div>
  </details>;
}

export function RegistryWorkspace(props: RegistryWorkspaceProps) {
  const visible = useMemo(() => filterRegistry(props.entries, props.filters as RegistryFilters), [props.entries, props.filters]);
  const groupedLessonBrowse = props.filters.kind === "lesson" && !props.filters.query.trim();
  const lessonBrowse = useMemo(() => {
    if (!groupedLessonBrowse) return { groups: [] as RegistryLessonGroup[], standalone: visible };
    const groups = new Map<string, RegistryLessonGroup>();
    const standalone: RegistryEntry[] = [];
    for (const entry of visible) {
      if (!entry.series) { standalone.push(entry); continue; }
      const id = `${entry.publisher}/${entry.series.id}`;
      const group = groups.get(id) ?? { id, title: entry.series.title, url: entry.series.url, entries: [] };
      group.entries.push(entry);
      groups.set(id, group);
    }
    for (const group of groups.values()) group.entries.sort((left, right) => (left.series?.order ?? 0) - (right.series?.order ?? 0) || left.title.localeCompare(right.title));
    return { groups: [...groups.values()], standalone };
  }, [visible, groupedLessonBrowse]);
  const queryMatches = useMemo(() => filterRegistry(props.entries, { query: props.filters.query, sort: "relevance" }), [props.entries, props.filters.query]);
  const facetBase = useMemo(() => queryMatches.filter(entry => props.filters.kind === "all" || entry.kind === props.filters.kind), [queryMatches, props.filters.kind]);
  const categories = useMemo(() => [...new Set([...facetBase.flatMap(entry => entry.categories), ...(props.filters.category ? [props.filters.category] : [])])].sort(), [facetBase, props.filters.category]);
  const runtimes = useMemo(() => [...new Set([...facetBase.flatMap(entry => entry.compatibility.runtimes), ...(props.filters.runtime ? [props.filters.runtime] : [])])].sort(), [facetBase, props.filters.runtime]);
  const selected = visible.find(entry => entryKey(entry) === props.selectedKey) ?? null;
  const catalogueUrl = publicRegistryUrl(props.filters, props.selectedKey);

  useEffect(() => {
    if (!props.selectedKey && !props.filters.query && visible.length) {
      const firstDirectResult = groupedLessonBrowse ? lessonBrowse.standalone[0] : visible[0];
      if (firstDirectResult) props.onSelect(firstDirectResult);
      return;
    }
    if (props.selectedKey && !visible.some(entry => entryKey(entry) === props.selectedKey)) props.onSelect(null);
  }, [visible, lessonBrowse.standalone, groupedLessonBrowse, props.selectedKey, props.filters.query, props.onSelect]);

  const activeFilterCount = [props.filters.category, props.filters.runtime,
    props.filters.access !== "all" ? props.filters.access : "",
    props.filters.verification !== "all" ? props.filters.verification : ""].filter(Boolean).length;

  function renderResult(entry: RegistryEntry, insideCollection = false) {
    const installed = entry.kind === "lesson" && props.installedLessons.has(entryKey(entry));
    const outdated = entry.kind === "lesson" && props.outdatedLessons.has(entryKey(entry));
    const opened = entry.kind === "lesson" && props.openLessons.has(entryKey(entry));
    const modified = entry.kind === "lesson" && props.modifiedLessons.has(entryKey(entry));
    const prepared = entry.kind === "dataset" && props.preparedDatasets.has(entry.id);
    return <button className={`registry-result-card kind-${entry.kind} ${entryKey(entry) === props.selectedKey ? "selected" : ""}`} key={entryKey(entry)} onClick={() => props.onSelect(entry)}>
      <div className="result-card-top"><span className="kind-label">{entry.kind}</span><EntryBadges entry={entry} installed={installed} outdated={outdated} opened={opened} modified={modified} prepared={prepared}/></div>
      {entry.series && <span className="result-series">{insideCollection ? entry.series.chapter : `${entry.series.title} · ${entry.series.chapter}`}</span>}
      <h2>{entry.title}</h2><p>{entry.summary}</p>
      <div className="result-card-tags">{entry.categories.map(category => <span key={category}>{category}</span>)}</div>
      <div className="result-card-foot"><span>{entry.publisher} / {entry.name}</span><span>v{entry.version}</span>{entry.dataset && <span>{displayBytes(entry.dataset.totalBytes)}</span>}</div>
    </button>;
  }

  return <main className="registry-main">
    <section className="registry-hero">
      <div><h1>Registry</h1><span>Search verified, on-demand BioLang content.</span></div>
      <div className="registry-connection">
        <a href={catalogueUrl} target="_blank" rel="noreferrer">View full catalogue</a>
        <a href={DEFAULT_REGISTRY_URL} target="_blank" rel="noreferrer">JSON API</a>
        <span className={`connection-dot ${props.source === "unavailable" ? "offline" : ""}`}/>
        <strong>{sourceLabel(props.source)}</strong>{props.checkedAt && <small title={props.checkedAt}>{props.source === "cache" ? "cached" : "checked"} {checkedLabel(props.checkedAt)}</small>}
        <button onClick={props.onRefresh} disabled={props.source === "loading"}>Refresh</button>
      </div>
    </section>

    {props.notice && <div className={`notice notice-${props.notice.tone}`} role={props.notice.tone === "bad" ? "alert" : "status"} aria-live={props.notice.tone === "bad" ? "assertive" : "polite"}><span>{props.notice.text}</span><button aria-label="Dismiss message" onClick={props.onDismissNotice}>×</button></div>}
    {props.source === "unavailable" && <div className="registry-alert"><div><strong>Registry unavailable</strong><span>{props.error || "Installed lessons and local notebooks remain available."}</span><small>Check the connection, retry, or copy the JSON API URL for diagnosis. Installed content is unaffected.</small></div><div><button onClick={props.onRefresh}>Retry</button><a href={catalogueUrl} target="_blank" rel="noreferrer">Open catalogue</a><button onClick={() => void navigator.clipboard.writeText(DEFAULT_REGISTRY_URL).catch(() => undefined)}>Copy API URL</button></div></div>}

    <section className="registry-controls" aria-label="Registry filters">
      <label className="registry-search"><span>Search</span><input aria-label="Registry search" value={props.filters.query} onChange={event => props.onFiltersChange({ query: event.target.value })} placeholder="Try single-cell, Homo sapiens, CSV, or statistics"/></label>
      <div className="registry-kind-tabs" role="tablist" aria-label="Registry content type">
        {KINDS.map(kind => <button key={kind.value} role="tab" aria-selected={props.filters.kind === kind.value} className={props.filters.kind === kind.value ? "active" : ""} onClick={() => props.onFiltersChange({ kind: kind.value })}>
          {kind.label}<span>{queryMatches.filter(entry => kind.value === "all" || entry.kind === kind.value).length}</span>
        </button>)}
      </div>
      <div className="registry-filter-grid">
        <label>Category<select aria-label="Registry category" value={props.filters.category} onChange={event => props.onFiltersChange({ category: event.target.value })}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Runtime<select aria-label="Registry runtime" value={props.filters.runtime} onChange={event => props.onFiltersChange({ runtime: event.target.value })}><option value="">Any runtime</option>{runtimes.map(value => <option key={value}>{value}</option>)}</select></label>
        {props.filters.kind === "dataset" && <label>Access<select aria-label="Registry access" value={props.filters.access} onChange={event => props.onFiltersChange({ access: event.target.value as RegistryAccessFilter })}><option value="all">Any access</option><option value="public">Public</option><option value="registration">Registration</option><option value="controlled">Controlled</option></select></label>}
        <label>Publisher trust<select aria-label="Registry verification" value={props.filters.verification} onChange={event => props.onFiltersChange({ verification: event.target.value as RegistryVerificationFilter })}><option value="all">Any publisher</option><option value="verified">Publisher verified</option><option value="unverified">Publisher unverified</option></select></label>
        <label>Sort<select aria-label="Registry sort" value={props.filters.sort} onChange={event => props.onFiltersChange({ sort: event.target.value as RegistrySort })}><option value="relevance">Best match</option><option value="recent">Recently published</option><option value="name">Name</option><option value="size">Dataset size</option></select></label>
        <button className="clear-filters" disabled={!activeFilterCount} onClick={() => props.onFiltersChange({ category: "", runtime: "", access: "all", verification: "all" })}>Clear {activeFilterCount ? `(${activeFilterCount})` : ""}</button>
      </div>
    </section>

    <div className="registry-browser">
      <section className="registry-results" aria-label="Registry results">
        <div className="results-heading"><strong>{visible.length} result{visible.length === 1 ? "" : "s"}</strong><span>{props.filters.query ? `for “${props.filters.query}”` : "from the public registry"}</span></div>
        {props.source === "loading" ? <div className="registry-empty"><strong>Loading the registry…</strong></div> : visible.length ? groupedLessonBrowse ? <>
          {lessonBrowse.groups.map(group => <RegistrySeriesGroup group={group} selectedKey={props.selectedKey} key={group.id}>{group.entries.map(entry => renderResult(entry, true))}</RegistrySeriesGroup>)}
          {lessonBrowse.groups.length > 0 && lessonBrowse.standalone.length > 0 && <h2 className="registry-standalone-heading">Standalone lessons</h2>}
          {lessonBrowse.standalone.map(entry => renderResult(entry))}
        </> : visible.map(entry => renderResult(entry)) : <div className="registry-empty"><strong>No matching entries</strong><span>Try fewer words or clear one of the filters.</span></div>}
      </section>

      <aside className="registry-detail" aria-label="Registry entry details">
        {selected ? <RegistryDetail entry={selected} installed={selected.kind === "lesson" && props.installedLessons.has(entryKey(selected))} outdated={selected.kind === "lesson" && props.outdatedLessons.has(entryKey(selected))} opened={selected.kind === "lesson" && props.openLessons.has(entryKey(selected))} modified={selected.kind === "lesson" && props.modifiedLessons.has(entryKey(selected))} prepared={selected.kind === "dataset" && props.preparedDatasets.has(selected.id)} installing={props.installingId === selected.id} details={props.datasetDetails} detailLoading={props.detailLoading} detailError={props.detailError} onInstall={props.onInstall} onOpenLesson={props.onOpenLesson} onShareLesson={props.onShareLesson} onCopyCatalogueLink={props.onCopyCatalogueLink} onCopyChecksumLink={props.onCopyChecksumLink} onPrepare={props.onPrepare} onCopyCommand={props.onCopyCommand}/> : <div className="registry-empty"><strong>Select an entry</strong><span>Its compatibility, provenance and actions will appear here.</span></div>}
      </aside>
    </div>
  </main>;
}

interface RegistryDetailProps {
  entry: RegistryEntry;
  installed: boolean;
  outdated: boolean;
  opened: boolean;
  modified: boolean;
  prepared: boolean;
  installing: boolean;
  details: RegisteredDatasetManifest | null;
  detailLoading: boolean;
  detailError: string;
  onInstall: (entry: RegistryEntry) => void;
  onOpenLesson: (entry: RegistryEntry) => void;
  onShareLesson: (entry: RegistryEntry) => void;
  onCopyCatalogueLink: (entry: RegistryEntry) => void;
  onCopyChecksumLink: (entry: RegistryEntry) => void;
  onPrepare: (entry: RegistryEntry, details?: RegisteredDatasetManifest) => void;
  onCopyCommand: (entry: RegistryEntry) => void;
}

function RegistryDetail({ entry, installed, outdated, opened, modified, prepared, installing, details, detailLoading, detailError, onInstall, onOpenLesson, onShareLesson, onCopyCatalogueLink, onCopyChecksumLink, onPrepare, onCopyCommand }: RegistryDetailProps) {
  const browserReady = entry.compatibility.runtimes.includes("browser") && entry.dataset?.access !== "controlled" && (entry.dataset?.totalBytes ?? 0) <= 50 * 1024 ** 2;
  return <div className={`detail-card kind-${entry.kind}`}>
    <div className="detail-heading"><span className="kind-label">{entry.kind}</span><EntryBadges entry={entry} installed={installed} outdated={outdated} opened={opened} modified={modified} prepared={prepared}/><h2>{entry.title}</h2><code>{entry.id}@{entry.version}</code><p>{details?.description || entry.summary}</p></div>

    <div className="detail-actions">
      {entry.kind === "lesson" && (outdated ? <button className="primary-action" aria-label={`Update ${entry.title}`} disabled={installing} onClick={() => onInstall(entry)}>{installing ? "Verifying update…" : "Update and open"}</button> : installed ? <button className="primary-action" aria-label={`Open ${entry.title}`} onClick={() => onOpenLesson(entry)}>Open lesson</button> : <button className="primary-action" aria-label={`Install ${entry.title}`} disabled={installing} onClick={() => onInstall(entry)}>{installing ? "Verifying…" : "Install and open"}</button>)}
      {entry.kind === "lesson" && <details className="registry-share"><summary>Share…</summary><div><button onClick={() => onCopyCatalogueLink(entry)}>Copy catalogue link</button><button onClick={() => onShareLesson(entry)}>Copy Studio link</button><button onClick={() => onCopyChecksumLink(entry)}>Copy checksum link</button></div></details>}
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
      {entry.series && <><div><dt>Book</dt><dd><a href={entry.series.url} target="_blank" rel="noreferrer">{entry.series.title} ↗</a></dd></div><div><dt>Chapter</dt><dd>{entry.series.chapter}</dd></div></>}
      {entry.dataset && <><div><dt>Access</dt><dd>{entry.dataset.access}</dd></div><div><dt>Size</dt><dd>{displayBytes(entry.dataset.totalBytes)} · {entry.dataset.fileCount} file{entry.dataset.fileCount === 1 ? "" : "s"}</dd></div></>}
      {entry.provider && <><div><dt>Authentication</dt><dd>{entry.provider.authentication}</dd></div><div><dt>Adapter</dt><dd>{entry.provider.adapter}</dd></div></>}
    </dl>

    <DetailGroup title="Runs with" values={entry.compatibility.runtimes}/>
    <DetailGroup title="Categories" values={entry.categories}/>
    {!!entry.tags.length && <DetailGroup title="Tags" values={entry.tags}/>} 
    {!!entry.discoverability?.problems.length && <DetailGroup title="Problems this helps solve" values={entry.discoverability.problems}/>}
    {!!entry.discoverability?.methods.length && <DetailGroup title="Methods" values={entry.discoverability.methods}/>}
    {!!entry.discoverability?.plots.length && <DetailGroup title="Plots" values={entry.discoverability.plots}/>}
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
