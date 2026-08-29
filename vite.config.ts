import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const LESSON_RAW_PREFIX = "https://raw.githubusercontent.com/oriclabs/biolang-lessons/main/";

function within(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function fileFor(root: string, requestPath: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  const candidate = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (!within(root, candidate) || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  const canonical = realpathSync(candidate);
  return within(root, canonical) ? canonical : null;
}

function sendFile(path: string, response: ServerResponse) {
  const types: Record<string, string> = {
    ".bln": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  };
  response.statusCode = 200;
  response.setHeader("Content-Type", types[extname(path).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  createReadStream(path).pipe(response);
}

function localContentPlugin(): Plugin {
  const configuredRegistryRoot = resolve(process.env.BIOLANG_LOCAL_REGISTRY_DIR || "../biolang-registry/registry");
  const configuredLessonsRoot = resolve(process.env.BIOLANG_LOCAL_LESSONS_DIR || "../biolang-lessons");
  return {
    name: "biolang-local-content",
    apply: "serve",
    configureServer(server) {
      if (!existsSync(configuredRegistryRoot) || !existsSync(configuredLessonsRoot)) return;
      const registryRoot = realpathSync(configuredRegistryRoot);
      const lessonsRoot = realpathSync(configuredLessonsRoot);
      server.middlewares.use("/__biolang/registry", (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const file = fileFor(registryRoot, pathname);
        if (!file) { next(); return; }
        if (pathname === "/v1/index.json") {
          const registry = JSON.parse(readFileSync(file, "utf8")) as { entries?: Array<{ kind?: string; manifest?: string; manifestSha256?: string }> };
          for (const entry of registry.entries ?? []) {
            if (entry.kind !== "lesson" || !entry.manifest?.startsWith(LESSON_RAW_PREFIX)) continue;
            const lessonPath = entry.manifest.slice(LESSON_RAW_PREFIX.length);
            const localManifest = fileFor(lessonsRoot, lessonPath);
            if (!localManifest) continue;
            const bytes = readFileSync(localManifest);
            entry.manifest = `/__biolang/lessons/${lessonPath}`;
            entry.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(`${JSON.stringify(registry, null, 2)}\n`);
          return;
        }
        sendFile(file, response);
      });
      server.middlewares.use("/__biolang/lessons", (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const file = fileFor(lessonsRoot, pathname);
        if (!file) { next(); return; }
        sendFile(file, response);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localContentPlugin()],
  base: "./",
  worker: { format: "es" },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless"
    }
  }
});
