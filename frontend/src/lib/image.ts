/**
 * Downscale an image file to a square-ish thumbnail suitable for an avatar.
 * Returns a JPEG/PNG Blob (PNG preserved only when the source has transparency
 * is not detected — we keep it simple and emit JPEG for photos, PNG fallback).
 * Keeps the payload tiny so it can be stored inline as a base64 data-URI.
 */
export async function downscaleImage(file: File, maxSize = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // unsupported by createImageBitmap — send as-is

  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise<Blob>((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob ?? file),
      "image/jpeg",
      0.85,
    );
  });
}
