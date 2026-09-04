import { describe, expect, it } from "vitest";
import { ensureSvgViewBox, svgPlotSize } from "../src/plot-sizing";

describe("responsive SVG plot sizing", () => {
  it("prefers the viewBox aspect ratio", () => {
    expect(svgPlotSize('<svg width="1200" height="900" viewBox="0 0 900 500"></svg>')).toEqual({ width: 900, height: 500, ratio: 1.8 });
  });

  it("uses numeric dimensions and has a safe fallback", () => {
    expect(svgPlotSize('<svg width="640px" height="320px"></svg>').ratio).toBe(2);
    expect(svgPlotSize("<svg></svg>").ratio).toBeCloseTo(900 / 520);
  });

  it("adds an explicit viewBox when a plot only declares dimensions", () => {
    expect(ensureSvgViewBox('<svg width="640" height="320"></svg>')).toContain('viewBox="0 0 640 320"');
    expect(ensureSvgViewBox('<svg viewBox="0 0 10 5"></svg>')).toBe('<svg viewBox="0 0 10 5"></svg>');
  });
});
