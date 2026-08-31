export type NotebookCodeLanguage = "biolang" | "javascript";

export const NOTEBOOK_CODE_LANGUAGE_KEY = "biolang-studio:code-language";

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
