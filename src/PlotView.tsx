import { useEffect, useMemo, useRef, useState } from "react";
import { svgPlotSize, type PlotSize } from "./plot-sizing";
import { svgToPngBlob } from "./plot-export";

function svgDocument(markup: string) {
  return `<!doctype html><meta name="color-scheme" content="light"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}body{display:grid;place-items:center}svg{display:block;width:100%!important;height:100%!important;max-width:100%;max-height:100%}</style>${markup}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function downloadPng(markup: string, _size: PlotSize) {
  downloadBlob(await svgToPngBlob(markup), "biolang-plot.png");
}

export function PlotView({ markup }: { markup: string }) {
  const size = useMemo(() => svgPlotSize(markup), [markup]);
  const host = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(720);
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState("");
  const frameHeight = Math.min(560, Math.max(240, hostWidth / size.ratio));

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setHostWidth(element.getBoundingClientRect().width || 720);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    addEventListener("keydown", close); return () => removeEventListener("keydown", close);
  }, [expanded]);

  const frame = (large = false) => <iframe title={large ? "Expanded BioLang plot" : "BioLang plot"} className="plot-frame" sandbox="" srcDoc={svgDocument(markup)} />;
  return <div className="plot-view" ref={host}>
    <div className="plot-toolbar" aria-label="Plot actions"><button onClick={() => setExpanded(true)}>Expand</button><button onClick={() => downloadBlob(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }), "biolang-plot.svg")}>Export SVG</button><button onClick={() => void downloadPng(markup, size).catch(error => setExportError(error instanceof Error ? error.message : String(error)))}>Save PNG</button></div>
    <div className="plot-inline" style={{ height: `${frameHeight}px` }} title="Drag the bottom-right handle to resize">{frame()}</div>
    {exportError && <p className="plot-export-error" role="alert">{exportError}</p>}
    {expanded && <div className="plot-lightbox" role="dialog" aria-modal="true" aria-label="Expanded plot" onMouseDown={event => { if (event.target === event.currentTarget) setExpanded(false); }}><div className="plot-lightbox-panel"><div className="plot-lightbox-head"><span>BioLang plot</span><button aria-label="Close expanded plot" onClick={() => setExpanded(false)}>×</button></div>{frame(true)}</div></div>}
  </div>;
}
