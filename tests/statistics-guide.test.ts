import { describe, expect, it } from "vitest";
import { generateStatisticsNotebook, STATISTICS_TASKS } from "../src/statistics-guide";

describe("guided statistics notebooks", () => {
  it("keeps the selected Welch method and data columns explicit", () => {
    const source = generateStatisticsNotebook("compare", "measurements.csv", "control,treated", "welch");
    expect(source).toContain('stat.compare_groups(data["control"], data["treated"], {method: "welch"})');
    expect(source).toContain("does not infer pairing");
  });

  it("has one schema entry for each task-first package helper", () => {
    expect(STATISTICS_TASKS.map(task => task.id)).toEqual([
      "compare", "compare-many", "counts", "stratified", "relationship", "paired", "dose-response", "survival", "meta",
    ]);
  });

  it("rejects an incompatible method", () => {
    expect(() => generateStatisticsNotebook("paired", "measurements.csv", "before,after", "welch")).toThrow(/not available/);
  });
});
