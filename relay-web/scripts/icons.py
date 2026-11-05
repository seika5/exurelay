"""Draw Exurelay's app icons (a speech bubble on the accent color) as PNGs, with no image libraries.
Run: python3 scripts/icons.py  (writes public/icon-192.png, icon-512.png, apple-touch-icon.png, icon-maskable-512.png)"""
import struct, zlib, math, os

BG = (124, 58, 237)      # a darker shade of --accent (#a78bfa), so white reads on it
FG = (255, 255, 255)

def png(path, size, pixels):
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pixels)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)

def inside_rounded(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def draw(size, padding, rounded_bg):
    s = 4  # supersampling
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            cov_bg = cov_fg = 0
            for sy in range(s):
                for sx in range(s):
                    x = (px + (sx + 0.5) / s) / size
                    y = (py + (sy + 0.5) / s) / size
                    bg = inside_rounded(x, y, 0, 0, 1, 1, 0.22) if rounded_bg else True
                    if not bg:
                        continue
                    cov_bg += 1
                    p = padding
                    bubble = inside_rounded(x, y, p, p + 0.04, 1 - p, 0.72 - p * 0.3, 0.12)
                    # tail: triangle below the bubble, left of center
                    tx0, tx1, ty0, ty1 = 0.30, 0.46, 0.66 - p * 0.3, 0.86 - p * 0.5
                    tail = ty0 <= y <= ty1 and tx0 <= x <= tx1 - (tx1 - tx0) * (y - ty0) / (ty1 - ty0)
                    # three dots inside the bubble
                    dots = any((x - cx) ** 2 + (y - 0.43) ** 2 <= 0.055 ** 2 for cx in (0.33, 0.5, 0.67))
                    if (bubble or tail) and not dots:
                        cov_fg += 1
            n = s * s
            a = cov_bg / n
            f = cov_fg / max(cov_bg, 1)
            col = tuple(round(BG[i] * (1 - f) + FG[i] * f) for i in range(3))
            row.append(col + (round(255 * a),))
        rows.append(row)
    return rows

out = os.path.join(os.path.dirname(__file__), "..", "public")
png(os.path.join(out, "icon-192.png"), 192, draw(192, 0.18, True))
png(os.path.join(out, "icon-512.png"), 512, draw(512, 0.18, True))
png(os.path.join(out, "apple-touch-icon.png"), 180, draw(180, 0.18, False))
# Maskable: full-bleed background, content inside the 80% safe zone.
png(os.path.join(out, "icon-maskable-512.png"), 512, draw(512, 0.26, False))
print("icons written")
