import { describe, expect, it } from "vitest";
import { compileSafeJavaScript } from "./javascript";
import { isLegacyGeneratedJavaScript } from "./language";

describe("safe JavaScript notebook cells", () => {
  it("distinguishes old generated builders from user-written JavaScript", () => {
    expect(isLegacyGeneratedJavaScript(`// \`bl\` is the persistent BioLang session; \`bio\` is the JavaScript SDK.
const result = await bio.program(bio.let_("mean", bio.callExpr("mean", []))).run(bl);`)).toBe(true);
    expect(isLegacyGeneratedJavaScript("const result = await bio.program(customStep).run(bl);")).toBe(false);
    expect(isLegacyGeneratedJavaScript("let mean = bl.mean(measurements);\nmean;")).toBe(false);
  });

  it("accepts direct BioLang API calls and field reads", () => {
    const result = compileSafeJavaScript("let values = [1, 2, 3];\nlet report = await bl.summary(values);\nreport.mean;");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingNames).toEqual(["values", "report"]);
      expect(result.executable).toContain("return { result: (report.mean)");
      expect(result.biolangSource).toBe("let values = [1, 2, 3]\nlet report = summary(values)\n(report).mean");
    }
  });

  it("maps JavaScript camelCase builtin names back to BioLang", () => {
    const result = compileSafeJavaScript('let table = bl.readCsv("data.csv");\nlet complete = bl.dropNull(table, "Height");\ncomplete;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.biolangSource).toContain('read_csv("data.csv")');
      expect(result.biolangSource).toContain('drop_null(table, "Height")');
      expect(result.biolangSource).not.toContain("readCsv");
    }
  });

  it("restores JavaScript bridge helpers to BioLang syntax", () => {
    const result = compileSafeJavaScript(`let no = bl.col(table, "No");
let first = bl.indexValue(no, 0);
let same = bl.equalValues(first, 7);
let total = bl.addValues(first, 2);
let plot = bl.callNamed("histogram", [no], { bins: 12, bin_rule: "ggplot" });
({ first, same, total, plot });`, ["table"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.biolangSource).toContain("let first = (no)[0]");
      expect(result.biolangSource).toContain("let same = (first == 7)");
      expect(result.biolangSource).toContain("let total = (first + 2)");
      expect(result.biolangSource).toContain('histogram(no, bins: 12, bin_rule: "ggplot")');
      expect(result.biolangSource).not.toMatch(/index_value|equal_values|add_values|call_named/);
    }
  });

  it.each([
    "fetch('https://example.com')",
    "globalThis.location",
    "bl.run('print(1)')",
    "Function('return 1')()",
    "let x = {}; x.constructor",
    "/unsafe/",
    "while (true) {}",
  ])("rejects unsafe JavaScript: %s", source => {
    expect(compileSafeJavaScript(source).ok).toBe(false);
  });

  it("permits values from earlier cells", () => {
    expect(compileSafeJavaScript("await bl.mean(values)", ["values"]).ok).toBe(true);
  });

  it("produces canonical BioLang without running the JavaScript", () => {
    const result = compileSafeJavaScript(`let mean = await bl.mean(measurements);\nlet median = await bl.median(measurements);\nlet result = { mean: mean, median: median };\nresult;`, ["measurements"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingNames).toEqual(["mean", "median", "result"]);
      expect(result.biolangSource).toBe("let mean = mean(measurements)\nlet median = median(measurements)\nlet result = {mean: mean, median: median}\nresult");
    }
  });
});
