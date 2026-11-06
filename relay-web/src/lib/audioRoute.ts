/**
 * Earpiece or loudspeaker for calls on a phone. Safari's Audio Session API is the only control a web app has:
 * "play-and-record" tells iOS this is a call, which plays through the earpiece (the quieter one, the default here);
 * "playback" plays through the loudspeaker. Only a hint to the system: other browsers don't have it, and then the
 * phone decides.
 */
type AudioSessionLike = { type: string };
const KEY = "relay.callSpeaker";

export function canChooseSpeaker(): boolean {
  return typeof navigator !== "undefined" && "audioSession" in navigator && window.matchMedia("(pointer: coarse)").matches;
}

export function speakerPreferred(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Route call audio to the loudspeaker (true) or the earpiece (false), and remember the choice. */
export function setSpeaker(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; still applied below.
  }
  applyAudioRoute();
}

/** Apply the remembered choice (when a call starts, and after a change). */
export function applyAudioRoute(): void {
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  if (!session) return;
  try {
    session.type = speakerPreferred() ? "playback" : "play-and-record";
  } catch {
    // An older Safari that doesn't take this type.
  }
}

/** After a call: back to the normal handling for any other sound. */
export function resetAudioRoute(): void {
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  if (session) {
    try {
      session.type = "auto";
    } catch {
      // ignore
    }
  }
}
