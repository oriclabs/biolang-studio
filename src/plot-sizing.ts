export type PlotSize = { width: number; height: number; ratio: number };

function numericAttribute(markup: string, name: string) {
  const match = markup.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"));
  return match ? Number(match[1]) : undefined;
}

export function svgPlotSize(markup: string): PlotSize {
  const viewBox = markup.match(/\bviewBox\s*=\s*["']\s*([-+\d.eE]+)[,\s]+([-+\d.eE]+)[,\s]+([-+\d.eE]+)[,\s]+([-+\d.eE]+)\s*["']/i);
  const viewWidth = viewBox ? Number(viewBox[3]) : undefined;
  const viewHeight = viewBox ? Number(viewBox[4]) : undefined;
  const width = viewWidth && viewWidth > 0 ? viewWidth : numericAttribute(markup, "width") ?? 900;
  const height = viewHeight && viewHeight > 0 ? viewHeight : numericAttribute(markup, "height") ?? 520;
  return { width, height, ratio: width / height };
}

export function ensureSvgViewBox(markup: string) {
  if (/\bviewBox\s*=/i.test(markup)) return markup;
  const size = svgPlotSize(markup);
  return markup.replace(/<svg\b/i, `<svg viewBox="0 0 ${size.width} ${size.height}" preserveAspectRatio="xMidYMid meet"`);
}
