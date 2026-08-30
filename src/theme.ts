export type StudioTheme = "system" | "light" | "dark";

export const STUDIO_THEME_KEY = "biolang-studio:theme";

export function readStudioTheme(storage: Pick<Storage, "getItem"> = localStorage): StudioTheme {
  try {
    const stored = storage.getItem(STUDIO_THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch { return "system"; }
}

export function resolvedStudioTheme(theme: StudioTheme, prefersDark: boolean): "light" | "dark" {
  return theme === "system" ? prefersDark ? "dark" : "light" : theme;
}

export function applyStudioTheme(theme: StudioTheme, prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) {
  const resolved = resolvedStudioTheme(theme, prefersDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = theme;
  document.documentElement.style.colorScheme = resolved;
}

export function saveStudioTheme(theme: StudioTheme, storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(STUDIO_THEME_KEY, theme); } catch { /* Theme persistence is optional. */ }
}
