// Icons live on the endpoint's node, which the router reads on every request, so
// they are stored small: scaled to 128px on the long side and re-encoded. Falls back to
// the original when the browser can't decode it (some ICO files).
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
    const out = canvas.toDataURL("image/webp", 0.9);
    // Safari has no WebP encoder and returns PNG; either is fine, as long as it's smaller.
    return out.startsWith("data:image/") && out.length < dataUrl.length ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}
