import { describe, expect, it } from "vitest";
import { normalizeStandardJavaScriptOutput, prepareStandardJavaScript } from "./standard-javascript";

describe("standard JavaScript notebook cells", () => {
  it("accepts ordinary JavaScript and persists top-level names", () => {
    const result = prepareStandardJavaScript(`const values = [1, 2, 3].map(value => value * 2);\nconsole.log(values);\nvalues.reduce((sum, value) => sum + value, 0);`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declared).toEqual(["values"]);
      expect(result.executable).toContain('__scope["values"]');
      expect(result.executable).toContain("return (values.reduce");
    }
  });

  it("accepts functions, loops, Math, console and bl package calls", () => {
    const result = prepareStandardJavaScript(`function clean(xs) { return xs.filter(Number.isFinite); }\nlet total = 0;\nfor (const value of clean([1, 2, NaN])) total += value;\nconsole.log(Math.sqrt(total));\nconst report = await bl.mean([1, 2, 3]);\nreport.value;`);
    expect(result.ok).toBe(true);
  });

  it.each(["fetch('/secret')", "globalThis.location", "import('./module.js')", "({}).constructor", "this.window", "({ window })"])('blocks unavailable capability: %s', source => {
    expect(prepareStandardJavaScript(source).ok).toBe(false);
  });

  it("turns nested BioLang results into a tabular JavaScript record", () => {
    expect(normalizeStandardJavaScriptOutput({
      mean: { ok: true, value: "17.5", type: "Float", output: "" },
      median: { ok: true, value: "15", type: "Int", output: "" },
    })).toEqual({ mean: 17.5, median: 15 });
  });

  it("does not hide a failed BioLang call inside a successful JavaScript object", () => {
    expect(() => normalizeStandardJavaScriptOutput({ result: { ok: false, error: "mean requires data" } })).toThrow("mean requires data");
  });
});
