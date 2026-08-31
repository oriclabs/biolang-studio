import { describe, expect, it } from "vitest";
import { compileSafeJavaScript } from "./javascript";

describe("safe JavaScript notebook cells", () => {
  it("accepts direct BioLang API calls and field reads", () => {
    const result = compileSafeJavaScript("let values = [1, 2, 3];\nlet report = await bl.summary(values);\nreport.mean;");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingNames).toEqual(["values", "report"]);
      expect(result.executable).toContain("return { result: (report.mean)");
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
});
