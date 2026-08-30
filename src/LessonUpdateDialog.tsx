import type { CatalogEntry } from "./content/manifest";
import type { RegistryEntry } from "./content/registry";
import { DialogShell } from "./DialogShell";

function shortHash(hash: string | undefined) {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : "Not recorded";
}

export function LessonUpdateDialog({ installed, update, busy, close, confirm }: {
  installed: CatalogEntry;
  update: RegistryEntry;
  busy: boolean;
  close: () => void;
  confirm: () => void;
}) {
  return <DialogShell label={`Update ${update.title}`} close={busy ? () => undefined : close}>
    <section className="modal lesson-update-modal">
      <div className="lesson-launch-heading">
        <div><span>Lesson update</span><h2>{update.title}</h2></div>
        <strong className={update.verified ? "verified" : "unverified"}>{update.verified ? "Publisher verified" : "Publisher unverified"}</strong>
      </div>
      <p>Studio found a different manifest for this installed lesson. Review the pinned registry version before replacing the installed package.</p>
      <dl className="lesson-launch-facts">
        <div><dt>Installed checksum</dt><dd><code>{shortHash(installed.manifestSha256)}</code></dd></div>
        <div><dt>Available version</dt><dd>{update.id}@{update.version}</dd></div>
        <div><dt>New checksum</dt><dd><code>{shortHash(update.manifestSha256)}</code></dd></div>
        <div><dt>Validation</dt><dd>{update.validation}</dd></div>
      </dl>
      <div className="lesson-update-preserves">
        <strong>Your work is kept</strong>
        <span>Edited notebooks, prepared data, and workspace attachments are not replaced. Only the installed lesson package is updated.</span>
      </div>
      <details className="lesson-launch-integrity"><summary>Source and integrity</summary><a href={update.manifest} target="_blank" rel="noreferrer">Manifest ↗</a><a href={update.sourceRepository} target="_blank" rel="noreferrer">Source repository ↗</a><code>{update.manifestSha256}</code></details>
      <p className="modal-guidance">Studio will download the manifest again and require an exact SHA-256 match before accepting the update. Updating does not run lesson code.</p>
      <div className="lesson-launch-actions"><button disabled={busy} onClick={close}>Not now</button><button className="primary" disabled={busy} onClick={confirm}>{busy ? "Verifying update…" : "Update lesson"}</button></div>
    </section>
  </DialogShell>;
}
