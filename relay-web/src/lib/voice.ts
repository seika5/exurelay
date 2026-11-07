/** Voice messages: which recording format to use, and how they're named (ChatFile plays "voice-…" files at once). */

export const MAX_VOICE_MS = 5 * 60 * 1000;

/**
 * The recording format: MP4 (AAC) on Safari, which is what iPhones play best; Opus in WebM elsewhere. Falls back to
 * whatever else is supported, then to the browser's default ("").
 */
export function pickVoiceType(isSupported: (type: string) => boolean, preferMp4: boolean): string {
  const order = preferMp4
    ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return order.find((t) => isSupported(t)) ?? "";
}

export function voiceExtension(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t.startsWith("audio/webm") || t.startsWith("video/webm")) return "webm";
  if (t.startsWith("audio/ogg")) return "ogg";
  return "m4a";
}

const two = (n: number) => String(n).padStart(2, "0");

/** "voice-20261106-143012.m4a", in local time. */
export function voiceName(mimeType: string, at = new Date()): string {
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `voice-${stamp}.${voiceExtension(mimeType)}`;
}

export function isVoiceName(name: string): boolean {
  return /^voice-.*\.(m4a|webm|ogg|mp4|aac)$/i.test(name);
}

/** "1:05" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${two(s % 60)}`;
}
