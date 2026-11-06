"""Draws the app icon, a flat iPod classic. Run: python3 build/make_icon.py build/icon.png electron/icon.png"""
import math
import os
import struct
import sys
import zlib

SIZE = 512
SUPERSAMPLE = 4
CENTER = SIZE / 2
# Flat colours from the app's Mist palette.
BODY_COLOR, WHEEL_COLOR = (58, 64, 76), (84, 91, 105)
SCREEN_COLOR, LINE_COLOR, HIGHLIGHT_COLOR = (226, 234, 244), (150, 160, 175), (91, 130, 173)

# An iPod classic is about 0.6 times as wide as it is tall.
BODY_WIDTH, BODY_HEIGHT, BODY_RADIUS = 300, 492, 46
BODY_TOP = (SIZE - BODY_HEIGHT) / 2
SCREEN_INSET, SCREEN_TOP, SCREEN_HEIGHT, SCREEN_RADIUS = 30, 30, 196, 14
WHEEL_Y, WHEEL_RADIUS, BUTTON_RADIUS = 370, 104, 38
# The screen shows a menu: a highlighted row between two plain ones.
MENU_ROWS = [(0.22, LINE_COLOR), (0.46, HIGHLIGHT_COLOR), (0.70, LINE_COLOR)]
ROW_HEIGHT, LINE_THICKNESS = 40, 12


def in_rounded(x, y, left, top, width, height, radius):
    dx = max(left + radius - x, 0, x - (left + width - radius))
    dy = max(top + radius - y, 0, y - (top + height - radius))
    return dx * dx + dy * dy <= radius * radius and left <= x <= left + width and top <= y <= top + height


# The colour at a point on the iPod, or None where there's no iPod.
def shade(x, y):
    left = CENTER - BODY_WIDTH / 2
    if not in_rounded(x, y, left, BODY_TOP, BODY_WIDTH, BODY_HEIGHT, BODY_RADIUS):
        return None
    screen_left, screen_top = left + SCREEN_INSET, BODY_TOP + SCREEN_TOP
    screen_width = BODY_WIDTH - 2 * SCREEN_INSET
    if in_rounded(x, y, screen_left, screen_top, screen_width, SCREEN_HEIGHT, SCREEN_RADIUS):
        for position, color in MENU_ROWS:
            middle = screen_top + SCREEN_HEIGHT * position
            if color == HIGHLIGHT_COLOR:
                if abs(y - middle) <= ROW_HEIGHT / 2:
                    return color
            elif abs(y - middle) <= LINE_THICKNESS / 2 and screen_left + 22 <= x <= screen_left + screen_width * 0.62:
                return color
        return SCREEN_COLOR
    radius = math.hypot(x - CENTER, y - (BODY_TOP + WHEEL_Y))
    if BUTTON_RADIUS < radius <= WHEEL_RADIUS:
        return WHEEL_COLOR
    return BODY_COLOR


def draw():
    samples = SUPERSAMPLE * SUPERSAMPLE
    rows = []
    for py in range(SIZE):
        row = bytearray([0])
        for px in range(SIZE):
            total = [0, 0, 0]
            covered = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    color = shade(px + (sx + 0.5) / SUPERSAMPLE, py + (sy + 0.5) / SUPERSAMPLE)
                    if color is None:
                        continue
                    covered += 1
                    for i in range(3):
                        total[i] += color[i]
            color = [round(value / covered) for value in total] if covered else [0, 0, 0]
            row += bytes(color + [255 * covered // samples])
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
