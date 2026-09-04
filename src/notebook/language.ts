export type NotebookCodeLanguage = "biolang" | "javascript";

export const NOTEBOOK_CODE_LANGUAGE_KEY = "biolang-studio:code-language";
export const EXPERIMENTAL_JAVASCRIPT_NOTEBOOKS_KEY = "biolang-studio:experimental-javascript-notebooks";
const NOTEBOOK_LANGUAGE_MARKER = /^\s*<!--\s*bl:language\s+(biolang|javascript)\s*-->\s*(?:\n|$)/i;

/** Recognize JavaScript written by Studio's pre-direct structural generator.
 * The two-part signature is intentionally narrow so ordinary user code that
 * happens to call a builder is never replaced.
 */
export function isLegacyGeneratedJavaScript(source: string | undefined): boolean {
  if (!source) return false;
  return source.includes("// `bl` is the persistent BioLang session; `bio` is the JavaScript SDK.")
    && /const\s+result\s*=\s*await\s+bio\.program\s*\(/.test(source);
}

export function readNotebookCodeLanguage(
  url = typeof location === "undefined" ? "https://studio.lang.bio/" : location.href,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): NotebookCodeLanguage {
  try {
    const requested = new URL(url).searchParams.get("lang")?.toLowerCase();
    if (requested === "js" || requested === "javascript") return "javascript";
    if (requested === "bl" || requested === "biolang") return "biolang";
    const saved = storage?.getItem(NOTEBOOK_CODE_LANGUAGE_KEY);
    return saved === "javascript" ? "javascript" : "biolang";
  } catch { return "biolang"; }
}

export function saveNotebookCodeLanguage(
  language: NotebookCodeLanguage,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
) {
  try { storage?.setItem(NOTEBOOK_CODE_LANGUAGE_KEY, language); }
  catch { /* A language preference is useful, but never required. */ }
}

/** JavaScript notebooks remain available for SDK development, but are hidden
 * from ordinary learners until the direct frontend is ready to ship broadly. */
export function readExperimentalJavaScriptNotebooks(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): boolean {
  try { return storage?.getItem(EXPERIMENTAL_JAVASCRIPT_NOTEBOOKS_KEY) === "true"; }
  catch { return false; }
}

export function saveExperimentalJavaScriptNotebooks(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
) {
  try { storage?.setItem(EXPERIMENTAL_JAVASCRIPT_NOTEBOOKS_KEY, String(enabled)); }
  catch { /* Experimental preferences must never prevent Studio from opening. */ }
}

/** Read the notebook-local language without exposing its metadata as a cell. */
export function readNotebookSourceLanguage(source: string, fallback: NotebookCodeLanguage = "biolang"): NotebookCodeLanguage {
  const language = String(source ?? "").match(NOTEBOOK_LANGUAGE_MARKER)?.[1]?.toLowerCase();
  return language === "javascript" ? "javascript" : language === "biolang" ? "biolang" : fallback;
}

/** Persist the notebook-local frontend choice in a plain, portable .bln file. */
export function withNotebookCodeLanguage(source: string, language: NotebookCodeLanguage): string {
  const body = String(source ?? "").replace(NOTEBOOK_LANGUAGE_MARKER, "").replace(/^\n+/, "");
  return `<!-- bl:language ${language} -->\n\n${body}`;
}

export type CompiledNotebookCode = {
  language: NotebookCodeLanguage;
  frontendSource: string;
  biolangSource: string;
};

/** Compile the selected notebook frontend to the one kernel language. */
export function compileNotebookCode(source: string, language: NotebookCodeLanguage, javascriptSource?: string): CompiledNotebookCode {
  const biolangSource = String(source ?? "");
  return {
    language,
    frontendSource: language === "javascript" ? String(javascriptSource ?? "") : biolangSource,
    biolangSource,
  };
}
