import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const biolang = path.resolve(process.env.BIOLANG_SOURCE || path.join(root, "..", "biolang"));
const source = path.join(biolang, "desktop", "public", "wasm");
const destination = path.join(root, "public", "runtime");
const runtimeFiles = [
  ["bl_wasm.js", path.join(source, "bl_wasm.js")],
  ["bl_wasm_bg.wasm", path.join(source, "bl_wasm_bg.wasm")],
  ["biolang-dsl.js", path.join(biolang, "npm", "dsl.js")],
  ["dsl.js", path.join(biolang, "npm", "dsl.js")],
  ["session.js", path.join(biolang, "npm", "session.js")],
  ["objects.js", path.join(biolang, "npm", "objects.js")],
  ["values.js", path.join(biolang, "npm", "values.js")],
  ["somer.js", path.join(biolang, "npm", "somer.js")],
];

for (const [name, from] of runtimeFiles) {
  if (!existsSync(from)) throw new Error(`missing BioLang browser runtime: ${from}`);
  mkdirSync(destination, { recursive: true });
  cpSync(from, path.join(destination, name));
}

// A missing sibling module is otherwise served as index.html by Vite's SPA
// fallback and only appears in the browser as a misleading failure to import
// the top-level module. Validate the copied runtime's relative dependencies.
for (const [name] of runtimeFiles) {
  if (!name.endsWith(".js")) continue;
  const target = path.join(destination, name);
  const javascript = readFileSync(target, "utf8");
  const imports = [
    ...javascript.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g),
    ...javascript.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g),
  ];
  for (const match of imports) {
    const dependency = path.resolve(path.dirname(target), match[1]);
    if (!existsSync(dependency)) {
      throw new Error(`missing copied runtime dependency: ${name} imports ${match[1]}`);
    }
  }
}
console.log(`BioLang browser runtime copied from ${source}`);
