/** Sizing rules for sending a smaller copy of a big photo (the canvas work is in shrinkImage.ts). */

/** Photos over this ask whether to send a smaller copy. */
export const LARGE_IMAGE_BYTES = 2 * 1024 * 1024;
/** The smaller copy's long side, at most. */
export const MAX_SIDE = 2048;
export const JPEG_QUALITY = 0.85;

const SHRINKABLE = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

/** A photo type worth offering a smaller copy of, going by its MIME type or (when that's empty) its name. GIFs aren't: a redraw loses the animation. */
export function isShrinkable(type: string, name: string): boolean {
  const t = type.toLowerCase();
  if (t) return /^image\/(jpeg|png|webp|heic|heif)$/.test(t);
  return SHRINKABLE.has(ext(name));
}

export function shouldOfferSmaller(file: { size: number; type: string; name: string }): boolean {
  return file.size > LARGE_IMAGE_BYTES && isShrinkable(file.type, file.name);
}

/** Width and height scaled down to fit `max` on the long side, keeping the shape. Never scales up. */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** PNGs stay PNG (they may be see-through); everything else becomes JPEG. */
export function smallerType(type: string, name: string): "image/png" | "image/jpeg" {
  return type.toLowerCase() === "image/png" || (!type && ext(name) === "png") ? "image/png" : "image/jpeg";
}

/** The original name with the new type's extension: "IMG_1234.HEIC" -> "IMG_1234.jpg". */
export function smallerName(name: string, type: "image/png" | "image/jpeg"): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name || "photo";
  return `${stem}.${type === "image/png" ? "png" : "jpg"}`;
}

/** "4.3 MB" */
export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
