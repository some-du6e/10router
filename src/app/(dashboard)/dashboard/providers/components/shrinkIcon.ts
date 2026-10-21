// Icons live on the endpoint's node, which the router reads on every request, so
// they are stored small: scaled to 128px on the long side and re-encoded. Falls back to
// the original when the browser can't decode it (some ICO files). A see-through
// logo is padded onto a white tile, or a dark one when the logo is light.
const SIZE = 128;

export async function shrinkIcon(dataUrl: string): Promise<string> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth || SIZE, h = img.naturalHeight || SIZE;
    const scale = Math.min(1, SIZE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // A see-through logo (most favicons) would touch the tile's rounded corners
    // and get clipped: put it on a white tile with some room around it.
    if (seeThroughCorners(ctx, canvas.width, canvas.height)) {
      // No upscaling: the logo keeps its pixels, the tile grows around it.
      const side = Math.min(SIZE, Math.round(Math.max(canvas.width, canvas.height) / 0.72));
      const tile = document.createElement("canvas");
      tile.width = tile.height = side;
      const t = tile.getContext("2d");
      if (!t) return dataUrl;
      t.fillStyle = lightLogo(ctx, canvas.width, canvas.height) ? "#18181b" : "#fff";
      t.fillRect(0, 0, side, side);
      const k = (side * 0.72) / Math.max(w, h);
      t.imageSmoothingQuality = "high";
      t.drawImage(img, (side - w * k) / 2, (side - h * k) / 2, w * k, h * k);
      const out = tile.toDataURL("image/webp", 0.9);
      return out.startsWith("data:image/") ? out : dataUrl;
    }
    const out = canvas.toDataURL("image/webp", 0.9);
    // Safari has no WebP encoder and returns PNG; either is fine, as long as it's smaller.
    return out.startsWith("data:image/") && out.length < dataUrl.length ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

const seeThroughCorners = (ctx: CanvasRenderingContext2D, w: number, h: number) =>
  [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].every(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] < 128);

// Mean brightness of the opaque pixels: a white glyph would vanish on a white tile.
function lightLogo(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  return n > 0 && sum / n > 200;
}
