import { svgPlotSize } from "./plot-sizing";

export async function svgToPngBlob(markup: string) {
  const size = svgPlotSize(markup);
  const source = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The SVG could not be converted to PNG."));
      image.src = source;
    });
    const requestedWidth = Math.max(size.width, 1_200) * 2;
    const scale = Math.min(
      requestedWidth / size.width,
      Math.sqrt(16_000_000 / (size.width * size.height)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(size.width * scale));
    canvas.height = Math.max(1, Math.round(size.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot create a PNG canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("PNG export failed.")),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function svgToPngDataUrl(markup: string) {
  const blob = await svgToPngBlob(markup);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("PNG encoding failed."));
    reader.readAsDataURL(blob);
  });
}
