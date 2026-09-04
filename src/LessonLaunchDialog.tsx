import type { LessonManifest } from "./content/manifest";
import type { LessonLaunchRequest } from "./content/lesson-links";
import type { RegistryEntry } from "./content/registry";
import { publicRegistryUrl } from "./content/registry";
import { DialogShell } from "./DialogShell";

export interface LessonLaunchReview {
  request: LessonLaunchRequest;
  manifestUrl: string;
  manifest: LessonManifest;
  observedSha256: string;
  registryEntry?: RegistryEntry;
}

function displayBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function LessonLaunchDialog({ request, review, loading, error, busy, runtimeCompatible, close, install }:
  { request: LessonLaunchRequest | null; review: LessonLaunchReview | null; loading: boolean; error: string; busy: boolean; runtimeCompatible: boolean; close: () => void; install: (runAll: boolean) => void }) {
  const totalBytes = review?.manifest.datasets.reduce((sum, dataset) => sum + dataset.bytes, 0) ?? 0;
  const registry = review?.registryEntry;
  const recoveryUrl = request?.kind === "registry" ? publicRegistryUrl({}, `${request.id}@${request.version}`) : request?.manifest;
  const trust = registry?.verified ? "Registry checksum pinned · publisher verified" : review?.request.kind === "registry" ? "Registry checksum pinned · publisher unverified" : review?.request.sha256 ? "Direct manifest · shared checksum pinned" : "Direct manifest · unverified source";
  return <DialogShell label="Review shared lesson" close={busy ? () => undefined : close}>
    <section className="modal lesson-launch-modal">
      <div className="lesson-launch-heading"><div><span>Shared lesson</span><h2>{review?.manifest.title ?? "Review lesson"}</h2></div>{review && <strong className={registry?.verified ? "verified" : "unverified"}>{trust}</strong>}</div>
      {loading && <p role="status">Fetching and checking the lesson manifest…</p>}
      {error && <div className="lesson-launch-error" role="alert"><strong>Cannot open this lesson link</strong><span>{error}</span>{recoveryUrl && <div><a href={recoveryUrl} target="_blank" rel="noreferrer">{request?.kind === "registry" ? "Open catalogue entry ↗" : "Open manifest source ↗"}</a><button onClick={() => void navigator.clipboard.writeText(location.href).catch(() => undefined)}>Copy original link</button></div>}<small>Nothing was installed or executed. Check connectivity, runtime compatibility, the exact version and the displayed checksum before retrying.</small></div>}
      {review && <>
        <p>{review.manifest.summary}</p>
        <dl className="lesson-launch-facts">
          <div><dt>Lesson</dt><dd>{registry ? `${registry.id}@${registry.version}` : review.manifest.id}</dd></div>
          <div><dt>Runtime</dt><dd>{review.manifest.runtime}</dd></div>
          <div><dt>Required data</dt><dd>{review.manifest.datasets.length ? `${review.manifest.datasets.length} file${review.manifest.datasets.length === 1 ? "" : "s"} · ${displayBytes(totalBytes)}` : "None"}</dd></div>
          <div><dt>Estimated memory</dt><dd>{review.manifest.estimatedMemoryMb ? `${review.manifest.estimatedMemoryMb} MB` : "Not declared"}</dd></div>
          {registry && <><div><dt>Licence</dt><dd>{registry.licence}</dd></div><div><dt>Validation</dt><dd>{registry.validation}</dd></div></>}
        </dl>
        <details className="lesson-launch-integrity"><summary>Source and integrity</summary><a href={review.manifestUrl} target="_blank" rel="noreferrer">Manifest ↗</a><a href={review.manifest.source.url} target="_blank" rel="noreferrer">Original source ↗</a><code>{review.observedSha256}</code></details>
        <p className="modal-guidance">Nothing runs merely because this URL was opened. Studio will verify the manifest again, verify every declared data file after download, and execute only after you choose the run action below.</p>
        {!runtimeCompatible && <p className="lesson-launch-warning">This lesson requires the {review.manifest.runtime} runtime. Install it now, then select a compatible runtime before running.</p>}
      </>}
      <div className="lesson-launch-actions"><button disabled={busy} onClick={close}>Cancel</button>{review && <><button disabled={busy} onClick={() => install(false)}>{busy ? "Verifying…" : "Install and open"}</button><button className="primary" disabled={busy || !runtimeCompatible} title={!runtimeCompatible ? `Select the ${review.manifest.runtime} runtime before running` : undefined} onClick={() => install(true)}>{busy ? "Verifying…" : "Install, prepare & run all"}</button></>}</div>
    </section>
  </DialogShell>;
}
