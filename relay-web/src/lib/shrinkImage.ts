import { JPEG_QUALITY, fitWithin, smallerName, smallerType } from "@/lib/imageSize";

/** The photo decoded, or null when this browser can't (e.g. HEIC outside Safari). */
export function decodeImage(file: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalWidth > 0 ? img : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * A copy at most 2048px on the long side, or null if drawing it failed. Browsers apply the photo's rotation when
 * drawing it, and the copy has none of its metadata (location, camera).
 */
export async function shrinkImage(file: File, img: HTMLImageElement): Promise<File | null> {
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  const type = smallerType(file.type, file.name);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
  // Freed at once: iOS caps the memory all canvases can hold.
  canvas.width = canvas.height = 0;
  if (!blob) return null;
  return new File([blob], smallerName(file.name, type), { type, lastModified: file.lastModified });
}
