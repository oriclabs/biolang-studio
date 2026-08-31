import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const biolang = path.resolve(process.env.BIOLANG_SOURCE || path.join(root, "..", "biolang"));
const source = path.join(biolang, "desktop", "public", "wasm");
const destination = path.join(root, "public", "runtime");
for (const [name, from] of [
  ["bl_wasm.js", path.join(source, "bl_wasm.js")],
  ["bl_wasm_bg.wasm", path.join(source, "bl_wasm_bg.wasm")],
  ["biolang-dsl.js", path.join(biolang, "npm", "dsl.js")],
  ["dsl.js", path.join(biolang, "npm", "dsl.js")],
  ["session.js", path.join(biolang, "npm", "session.js")],
  ["objects.js", path.join(biolang, "npm", "objects.js")],
  ["somer.js", path.join(biolang, "npm", "somer.js")],
]) {
  if (!existsSync(from)) throw new Error(`missing BioLang browser runtime: ${from}`);
  mkdirSync(destination, { recursive: true });
  cpSync(from, path.join(destination, name));
}
console.log(`BioLang browser runtime copied from ${source}`);
