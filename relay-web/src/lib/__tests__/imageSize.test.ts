import { describe, expect, it } from "vitest";
import { fitWithin, formatMB, isShrinkable, shouldOfferSmaller, smallerName, smallerType, LARGE_IMAGE_BYTES } from "@/lib/imageSize";
import { formatElapsed, isVoiceName, pickVoiceType, voiceExtension, voiceName } from "@/lib/voice";

describe("imageSize", () => {
  it("fits the long side within 2048, keeping the shape", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(5000, 5000)).toEqual({ width: 2048, height: 2048 });
  });

  it("never scales up", () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(2048, 10)).toEqual({ width: 2048, height: 10 });
  });

  it("keeps very thin images at least 1px", () => {
    expect(fitWithin(100000, 10)).toEqual({ width: 2048, height: 1 });
  });

  it("offers a smaller copy only of big photos", () => {
    expect(shouldOfferSmaller({ size: LARGE_IMAGE_BYTES + 1, type: "image/jpeg", name: "a.jpg" })).toBe(true);
    expect(shouldOfferSmaller({ size: LARGE_IMAGE_BYTES, type: "image/jpeg", name: "a.jpg" })).toBe(false);
    expect(shouldOfferSmaller({ size: 9e6, type: "image/gif", name: "a.gif" })).toBe(false);
    expect(shouldOfferSmaller({ size: 9e6, type: "video/mp4", name: "a.mp4" })).toBe(false);
    // Some browsers leave HEIC's type empty.
    expect(shouldOfferSmaller({ size: 9e6, type: "", name: "IMG_1.HEIC" })).toBe(true);
    expect(isShrinkable("image/webp", "x")).toBe(true);
    expect(isShrinkable("image/svg+xml", "x.svg")).toBe(false);
  });

  it("keeps PNG as PNG, everything else becomes JPEG", () => {
    expect(smallerType("image/png", "a.png")).toBe("image/png");
    expect(smallerType("", "a.png")).toBe("image/png");
    expect(smallerType("image/heic", "a.heic")).toBe("image/jpeg");
    expect(smallerType("image/webp", "a.webp")).toBe("image/jpeg");
  });

  it("keeps the name's stem with the new extension", () => {
    expect(smallerName("IMG_1234.HEIC", "image/jpeg")).toBe("IMG_1234.jpg");
    expect(smallerName("my.photo.png", "image/png")).toBe("my.photo.png");
    expect(smallerName("noext", "image/jpeg")).toBe("noext.jpg");
    expect(smallerName("", "image/jpeg")).toBe("photo.jpg");
  });

  it("formats MB", () => {
    expect(formatMB(4.3 * 1024 * 1024)).toBe("4.3 MB");
  });
});

describe("voice", () => {
  const only = (...types: string[]) => (t: string) => types.includes(t);

  it("prefers MP4 on Safari, Opus elsewhere", () => {
    expect(pickVoiceType(only("audio/mp4", "audio/webm;codecs=opus"), true)).toBe("audio/mp4");
    expect(pickVoiceType(only("audio/mp4", "audio/webm;codecs=opus"), false)).toBe("audio/webm;codecs=opus");
    expect(pickVoiceType(only("audio/mp4"), false)).toBe("audio/mp4");
    expect(pickVoiceType(only(), false)).toBe("");
  });

  it("names files by type and time", () => {
    const at = new Date(2026, 10, 6, 14, 30, 12);
    expect(voiceName("audio/mp4;codecs=mp4a.40.2", at)).toBe("voice-20261106-143012.m4a");
    expect(voiceName("audio/webm;codecs=opus", at)).toBe("voice-20261106-143012.webm");
    expect(voiceExtension("")).toBe("m4a");
    expect(isVoiceName("voice-20261106-143012.webm")).toBe(true);
    expect(isVoiceName("voice-notes.pdf")).toBe(false);
    expect(isVoiceName("song.m4a")).toBe(false);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(300_000)).toBe("5:00");
  });
});
