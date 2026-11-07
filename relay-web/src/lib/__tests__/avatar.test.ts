import { describe, it, expect } from "vitest";
import {
  AVATAR_COLORS,
  AVATAR_PX,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_LENGTH,
  TARGET_AVATAR_BYTES,
  avatarColor,
  centerSquare,
  dataUrlBytes,
  encodeAttempts,
  initialOf,
  isAvatarData,
  pickEncoding,
} from "../avatar";

describe("avatar helpers", () => {
  it("picks the same color for a key hash every time, from the palette", () => {
    const k = "3fa9".padEnd(64, "0");
    expect(avatarColor(k)).toBe(avatarColor(k));
    expect(AVATAR_COLORS).toContain(avatarColor(k));
    expect(avatarColor("00000000".padEnd(64, "f"))).toBe(AVATAR_COLORS[0]);
    expect(avatarColor("00000001".padEnd(64, "f"))).toBe(AVATAR_COLORS[1]);
    expect(AVATAR_COLORS).toContain(avatarColor("not hex"));
    const used = new Set(Array.from({ length: 200 }, (_, i) => avatarColor((i * 2654435761 >>> 0).toString(16).padStart(8, "0"))));
    expect(used.size).toBe(AVATAR_COLORS.length);
  });

  it("takes the first character of a name", () => {
    expect(initialOf("ana")).toBe("A");
    expect(initialOf("  bo")).toBe("B");
    expect(initialOf("")).toBe("?");
    expect(initialOf(undefined)).toBe("?");
    expect(initialOf("😀 x")).toBe("😀");
  });

  it("accepts only small base64 image data URLs", () => {
    expect(isAvatarData("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isAvatarData("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isAvatarData("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isAvatarData("https://example.com/a.png")).toBe(false);
    expect(isAvatarData("data:image/png;base64,abc def")).toBe(false);
    expect(isAvatarData(42)).toBe(false);
    const max = "data:image/jpeg;base64," + "A".repeat((MAX_AVATAR_BYTES / 3) * 4 - 4) + "AAA=";
    expect(isAvatarData(max)).toBe(true);
    expect(max.length).toBeLessThanOrEqual(MAX_AVATAR_LENGTH);
    expect(isAvatarData("data:image/jpeg;base64," + "A".repeat(MAX_AVATAR_LENGTH))).toBe(false);
  });

  it("counts decoded bytes", () => {
    expect(dataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
    expect(dataUrlBytes("data:image/png;base64,AAA=")).toBe(2);
    expect(dataUrlBytes("data:image/png;base64,AA==")).toBe(1);
  });

  it("crops the centered square", () => {
    expect(centerSquare(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(centerSquare(300, 401)).toEqual({ sx: 0, sy: 50, side: 300 });
    expect(centerSquare(96, 96)).toEqual({ sx: 0, sy: 0, side: 96 });
  });

  it("tries full size first, quality falling, then smaller sides", () => {
    const a = encodeAttempts();
    expect(a[0].px).toBe(AVATAR_PX);
    expect(a[1].px).toBe(AVATAR_PX);
    expect(a[1].quality).toBeLessThan(a[0].quality);
    expect(a.at(-1)!.px).toBeLessThan(AVATAR_PX);
    for (let i = 1; i < a.length; i++) expect(a[i].px <= a[i - 1].px).toBe(true);
  });

  it("picks the first under the target, else the smallest that fits, else none", () => {
    expect(pickEncoding([20000, TARGET_AVATAR_BYTES, 100])).toBe(1);
    expect(pickEncoding([20000, MAX_AVATAR_BYTES, MAX_AVATAR_BYTES - 1])).toBe(2);
    expect(pickEncoding([20000, MAX_AVATAR_BYTES + 1])).toBeNull();
  });
});
