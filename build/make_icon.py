"""Draws the app icon. Run: python3 build/make_icon.py build/icon.png electron/icon.png

The note is measured after drawing and placed relative to the middle of the
tile, so changing its shape can't push it off centre.
"""
import math
import os
import struct
import sys
import zlib

SIZE = 512
SUPERSAMPLE = 4
TILE_INSET, TILE_RADIUS = 16, 108
BACKGROUND, FOREGROUND = (44, 0, 30), (233, 84, 32)

HEAD_RX, HEAD_RY, HEAD_TILT = 64, 46, math.radians(-20)
STEM_WIDTH, BEAM_THICKNESS = 30, 58
LEFT_HEAD, RIGHT_HEAD = (0, 250), (190, 215)
BEAM_RISE = 35
BEAM_HEIGHT = 215  # from the left head's centre up to the top of the beam
# The stems and beam make the note right-heavy, so exact centring looks off.
# This splits the difference between centring its edges and its visual weight.
OPTICAL_SHIFT_X = -13


def in_tile(x, y):
    low, high = TILE_INSET + TILE_RADIUS, SIZE - TILE_INSET - TILE_RADIUS
    dx, dy = max(low - x, 0, x - high), max(low - y, 0, y - high)
    return dx * dx + dy * dy <= TILE_RADIUS * TILE_RADIUS


def in_head(x, y, center):
    u, v = x - center[0], y - center[1]
    a = u * math.cos(HEAD_TILT) + v * math.sin(HEAD_TILT)
    b = -u * math.sin(HEAD_TILT) + v * math.cos(HEAD_TILT)
    return (a / HEAD_RX) ** 2 + (b / HEAD_RY) ** 2 <= 1


# Stems end flush with the rightmost point of each tilted head.
HEAD_REACH = math.hypot(HEAD_RX * math.cos(HEAD_TILT), HEAD_RY * math.sin(HEAD_TILT))
STEM_OVERLAP = -(HEAD_RX ** 2 - HEAD_RY ** 2) * math.sin(HEAD_TILT) * math.cos(HEAD_TILT) / HEAD_REACH
LEFT_STEM = LEFT_HEAD[0] + HEAD_REACH - STEM_WIDTH
RIGHT_STEM = RIGHT_HEAD[0] + HEAD_REACH - STEM_WIDTH
BEAM_LEFT, BEAM_RIGHT = LEFT_STEM, RIGHT_STEM + STEM_WIDTH
BEAM_TOP_LEFT = LEFT_HEAD[1] - BEAM_HEIGHT


def beam_top(x):
    return BEAM_TOP_LEFT - BEAM_RISE * (x - BEAM_LEFT) / (BEAM_RIGHT - BEAM_LEFT)


def in_note(x, y):
    if in_head(x, y, LEFT_HEAD) or in_head(x, y, RIGHT_HEAD):
        return True
    if not BEAM_LEFT <= x <= BEAM_RIGHT:
        return False
    top = beam_top(x)
    if top <= y <= top + BEAM_THICKNESS:
        return True
    # Stems stop inside the head, which rises to the right, so no corner pokes out.
    if LEFT_STEM <= x <= LEFT_STEM + STEM_WIDTH:
        return top <= y <= LEFT_HEAD[1] - STEM_OVERLAP
    if RIGHT_STEM <= x <= RIGHT_STEM + STEM_WIDTH:
        return top <= y <= RIGHT_HEAD[1] - STEM_OVERLAP
    return False


def note_offset():
    xs, ys = [], []
    for y in range(-200, 500):
        for x in range(-200, 500):
            if in_note(x + 0.5, y + 0.5):
                xs.append(x)
                ys.append(y)
    width_center = (min(xs) + max(xs) + 1) / 2
    height_center = (min(ys) + max(ys) + 1) / 2
    print(f"note is {max(xs) - min(xs) + 1} x {max(ys) - min(ys) + 1}")
    return SIZE / 2 - width_center + OPTICAL_SHIFT_X, SIZE / 2 - height_center


def draw():
    offset_x, offset_y = note_offset()
    samples = SUPERSAMPLE * SUPERSAMPLE
    rows = []
    for py in range(SIZE):
        row = bytearray([0])
        for px in range(SIZE):
            tile = note = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = px + (sx + 0.5) / SUPERSAMPLE
                    y = py + (sy + 0.5) / SUPERSAMPLE
                    if not in_tile(x, y):
                        continue
                    tile += 1
                    if in_note(x - offset_x, y - offset_y):
                        note += 1
            if tile:
                color = [(BACKGROUND[i] * (tile - note) + FOREGROUND[i] * note) // tile for i in range(3)]
            else:
                color = [0, 0, 0]
            row += bytes(color + [255 * tile // samples])
        rows.append(bytes(row))
    return rows


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def main(outputs):
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(b"".join(draw()), 9)) + chunk(b"IEND", b""))
    for output in outputs:
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        with open(output, "wb") as f:
            f.write(png)


if __name__ == "__main__":
    main(sys.argv[1:])
