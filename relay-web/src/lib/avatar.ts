/**
 * Profile pictures: a small square image each member sets, sent inside their sealed profile copies (profileSeal.ts),
 * so the server never sees it. Members without one get their initial on a color picked from their key hash, the same
 * on every device.
 */

/** Pixels per side. 96 is sharp at 32px on a 3x phone screen. */
export const AVATAR_PX = 96;
/** Encoded bytes at most. Every profile copy is padded to fit one this size (profileSeal.ts). */
export const MAX_AVATAR_BYTES = 8192;
/** Stop lowering quality once under this. */
export const TARGET_AVATAR_BYTES = 6144;
/** As a data URL: base64 plus the longest prefix ("data:image/jpeg;base64,"). */
export const MAX_AVATAR_LENGTH = Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 23;

/** Distinct, mid-tone colors that keep white text readable on the dark theme. */
export const AVATAR_COLORS = [
  "#e05d5d", // red
  "#e0864a", // orange
  "#c9a227", // amber
  "#5aa55a", // green
  "#2fa39a", // teal
  "#3b9ad9", // blue
  "#6b7be0", // indigo
  "#9b6be0", // violet
  "#d0609e", // pink
  "#8a8f98", // slate
];

/** A stable color for a member: from the first 8 hex digits of their key hash. */
export function avatarColor(keyHash: string): string {
  const n = parseInt(keyHash.slice(0, 8), 16);
  return AVATAR_COLORS[(Number.isFinite(n) ? n : 0) % AVATAR_COLORS.length];
}

/** The first letter (or other character) of a name, uppercased; "?" without one. */
export function initialOf(name: string | undefined): string {
  const first = [...(name ?? "").trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** A picture as it may arrive in a copy: a base64 WebP, JPEG or PNG data URL within the size limit. Nothing else is shown. */
export function isAvatarData(s: unknown): s is string {
  return typeof s === "string" && s.length <= MAX_AVATAR_LENGTH && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Bytes encoded in a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const b64 = url.slice(url.indexOf(",") + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

/** The centered square of a width x height image. */
export function centerSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/**
 * What to try, in order, until one fits: full size at falling quality, then smaller sides. The last one (32px at the
 * lowest quality) is far under the limit for any image, so a picture always ends up fitting.
 */
export function encodeAttempts(): { px: number; quality: number }[] {
  const out: { px: number; quality: number }[] = [];
  for (const px of [AVATAR_PX, 80, 64, 48, 32]) for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25]) out.push({ px, quality });
  return out;
}

/** The first encoding under the target, else the smallest under the hard limit, else null. */
export function pickEncoding(sizes: number[]): number | null {
  const under = sizes.findIndex((s) => s <= TARGET_AVATAR_BYTES);
  if (under >= 0) return under;
  let best: number | null = null;
  sizes.forEach((s, i) => {
    if (s <= MAX_AVATAR_BYTES && (best === null || s < sizes[best])) best = i;
  });
  return best;
}

/**
 * Turn a picked image file into a profile picture: center-cropped square, downscaled, re-encoded (WebP where the
 * browser can, else JPEG) at lower quality and size until it fits. Throws only if the image can't be read.
 */
export async function encodeAvatar(file: Blob): Promise<string> {
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await createImageBitmap(file);
  } catch {
    // Older Safari: load it through an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
    } catch {
      throw new Error("Couldn't read that image");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const { sx, sy, side } = centerSquare(source.width, source.height);
  if (!side) throw new Error("Couldn't read that image");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read that image");
  const sizes: number[] = [];
  const urls: string[] = [];
  for (const { px, quality } of encodeAttempts()) {
    canvas.width = canvas.height = px;
    // JPEG has no transparency: transparent parts turn dark, not black.
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(0, 0, px, px);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, side, side, 0, 0, px, px);
    let url = canvas.toDataURL("image/webp", quality);
    // Browsers that can't encode WebP hand back PNG.
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", quality);
    const size = dataUrlBytes(url);
    if (size <= TARGET_AVATAR_BYTES) return url;
    urls.push(url);
    sizes.push(size);
  }
  const pick = pickEncoding(sizes);
  if (pick === null) throw new Error("Couldn't read that image");
  return urls[pick];
}
