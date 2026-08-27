import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = path.join(root, "public", "catalog");
const catalog = JSON.parse(readFileSync(path.join(catalogRoot, "index.json"), "utf8"));
const failures = [];
for (const entry of catalog) {
  const relative = entry.manifest.replace(/^\.\/catalog\//, "");
  const manifestPath = path.join(catalogRoot, relative);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== 1 || manifest.id !== entry.id) failures.push(`${entry.id}: manifest identity mismatch`);
  const lesson = path.resolve(path.dirname(manifestPath), manifest.entry);
  if (!statSync(lesson).isFile()) failures.push(`${entry.id}: missing entry ${manifest.entry}`);
  for (const dataset of manifest.datasets ?? []) {
    if (!/^https:\/\//.test(dataset.url)) failures.push(`${entry.id}/${dataset.id}: dataset URL must use HTTPS`);
    if (!/^[a-f0-9]{64}$/.test(dataset.sha256)) failures.push(`${entry.id}/${dataset.id}: invalid SHA-256`);
    if (!Number.isInteger(dataset.bytes) || dataset.bytes <= 0) failures.push(`${entry.id}/${dataset.id}: invalid byte count`);
    const accidentallyBundled = path.join(path.dirname(manifestPath), dataset.path);
    try { if (statSync(accidentallyBundled).isFile()) failures.push(`${entry.id}/${dataset.id}: remote data was bundled`); } catch {}
  }
}
for (const item of readdirSync(catalogRoot)) if (item !== "index.json" && !catalog.some(entry => entry.manifest.includes(`/${item}/`))) failures.push(`orphan catalog directory: ${item}`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`${catalog.length} lesson manifest checked; remote datasets are references only.`);
