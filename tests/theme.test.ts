// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyStudioTheme, readStudioTheme, resolvedStudioTheme, saveStudioTheme, STUDIO_THEME_KEY } from "../src/theme";

describe("Studio themes", () => {
  it("resolves system appearance while preserving explicit choices", () => {
    expect(resolvedStudioTheme("system", true)).toBe("dark");
    expect(resolvedStudioTheme("system", false)).toBe("light");
    expect(resolvedStudioTheme("light", true)).toBe("light");
    expect(resolvedStudioTheme("dark", false)).toBe("dark");
  });

  it("persists valid preferences and applies the resolved theme", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    saveStudioTheme("dark", storage);
    expect(values.get(STUDIO_THEME_KEY)).toBe("dark");
    expect(readStudioTheme(storage)).toBe("dark");
    applyStudioTheme("system", true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("system");
  });
});
