#!/usr/bin/env python3
"""Draw the CURSORPHREAK wordmark in a classic desktop cursor-picker style.

Glyphs are built from rounded rectangles minus cut-outs on a small grid, rendered at high
resolution and downsampled, so the result is crisp at 1x and 2x.
Usage: python3 -I tools/make_logo.py src/renderer/logo.png
"""
import sys
from PIL import Image, ImageDraw

BLUE = (17, 124, 192, 255)
GREEN = (43, 198, 45, 255)

W, H = 20.0, 19.0  # glyph box in logical px
GAP = 2.0
R = 6.5  # outer corner radius
SV = 6.5  # vertical stroke width
SS = 4.6  # horizontal stroke height (top/bottom bars)
SLIT = 2.6  # counter slit height for two-storey letters


def glyph(ch):
    """Return (outer_rect_corners, cuts, adds). corners = (tl, tr, br, bl) booleans for rounding."""
    t, b = 6.4, H - 6.6  # inner counter top/bottom for single-counter letters (C, O, U)
    mid1 = (H - SLIT) / 2  # upper slit for S/E etc.
    upper_slit = (SS, SS + SLIT)
    lower_slit = (H - SS - SLIT, H - SS)
    bowl_bottom = SS + SLIT + SS  # bottom of the bowl bar for P/R/A
    cuts, adds = [], []
    if ch == "C":
        corners = (True, False, False, True)
        cuts = [("rr", (SV, t, W + 1, b), (True, False, False, True))]
    elif ch == "U":
        corners = (False, False, True, True)
        cuts = [("rr", (SV, -1, W - SV, H - 6.6), (False, False, True, True))]
    elif ch == "O":
        corners = (True, True, True, True)
        cuts = [("rr", (SV, t, W - SV, b), (True, True, True, True))]
    elif ch == "S":
        corners = (True, True, True, True)
        cuts = [
            ("rr", (SV, upper_slit[0], W + 1, upper_slit[1] + 0.4), (True, False, False, True)),
            ("rr", (-1, lower_slit[0] - 0.4, W - SV, lower_slit[1]), (False, True, True, False)),
        ]
    elif ch == "R":
        corners = (False, True, True, False)
        cuts = [
            ("rr", (SV, upper_slit[0], W - SV, upper_slit[1]), (True, True, True, True)),
            ("poly", [(SV, bowl_bottom), (W - SV - 0.2, bowl_bottom), (W - SV + 2.4, H + 1), (SV, H + 1)]),
        ]
    elif ch == "P":
        corners = (False, True, False, False)
        cuts = [
            ("rr", (SV, upper_slit[0], W - SV, upper_slit[1]), (True, True, True, True)),
            ("rect", (SV, bowl_bottom, W + 1, H + 1)),
        ]
        adds = [("rr", (0, 0, W, bowl_bottom), (False, True, True, False))]
    elif ch == "H":
        corners = (False, False, False, False)
        cuts = [("rect", (SV, -1, W - SV, upper_slit[1] + 0.6)), ("rect", (SV, lower_slit[0] - 0.6, W - SV, H + 1))]
    elif ch == "E":
        corners = (True, False, False, True)
        cuts = [
            ("rect", (SV, upper_slit[0], W + 1, upper_slit[1] + 0.4)),
            ("rect", (SV, lower_slit[0] - 0.4, W + 1, lower_slit[1])),
            ("rect", (W - 3.2, upper_slit[1], W + 1, lower_slit[0])),
        ]
    elif ch == "A":
        corners = (True, True, False, False)
        cuts = [
            ("rr", (SV, upper_slit[0], W - SV, upper_slit[1]), (True, True, True, True)),
            ("rect", (SV, bowl_bottom, W - SV, H + 1)),
        ]
    elif ch == "K":
        corners = None
        adds = [
            ("rect", (0, 0, SV, H)),
            ("poly", [(SV - 0.5, mid1 - 1.2), (W - SV - 0.5, 0), (W + 0.5, 0), (SV + 5.5, (H) / 2 + 0.2), (SV - 0.5, (H) / 2 + 2.4)]),
            ("poly", [(SV + 2.2, H / 2 - 1.2), (SV + 6.2, H / 2 - 1.6), (W + 0.5, H), (W - SV - 0.5, H)]),
        ]
    else:
        raise ValueError(ch)
    return corners, cuts, adds


def rrect(d, b, radius, fill, corners):
    radius = int(max(0, min(radius, (b[2] - b[0]) // 2 - 1, (b[3] - b[1]) // 2 - 1)))
    d.rounded_rectangle(b, radius=radius, fill=fill, corners=corners)


def draw_word(text_parts, scale):
    total = sum(len(t) for t, _ in text_parts)
    width = total * W + (total - 1) * GAP
    img = Image.new("RGBA", (int((width + 2) * scale), int((H + 2) * scale)), (0, 0, 0, 0))
    x = 1.0
    for text, color in text_parts:
        for ch in text:
            g = Image.new("L", img.size, 0)
            d = ImageDraw.Draw(g)

            def S(v):
                return v * scale

            def box(r, ox=x, oy=1.0):
                return [round(S(r[0] + ox)), round(S(r[1] + oy)), round(S(r[2] + ox)) - 1, round(S(r[3] + oy)) - 1]

            corners, cuts, adds = glyph(ch)
            if corners is not None:
                rrect(d, box((0, 0, W, H)), S(R), 255, corners)
            for kind, *args in adds:
                if kind == "rect":
                    d.rectangle(box(args[0]), fill=255)
                elif kind == "rr":
                    rrect(d, box(args[0]), S(R), 255, args[1])
                elif kind == "poly":
                    d.polygon([(S(px + x), S(py + 1.0)) for px, py in args[0]], fill=255)
            for kind, *args in cuts:
                if kind == "rect":
                    d.rectangle(box(args[0]), fill=0)
                elif kind == "rr":
                    rrect(d, box(args[0]), S(1.4), 0, args[1])
                elif kind == "poly":
                    d.polygon([(S(px + x), S(py + 1.0)) for px, py in args[0]], fill=0)
            layer = Image.new("RGBA", img.size, color)
            img.paste(layer, (0, 0), g)
            x += W + GAP
    return img


def main(out):
    parts = [("CURSOR", BLUE), ("PHREAK", GREEN)]
    for mult, suffix in ((1, ""), (2, "@2x")):
        big = draw_word(parts, 8 * mult)
        w, h = big.size
        small = big.resize((w // 8, h // 8), Image.LANCZOS)
        path = out.replace(".png", f"{suffix}.png")
        small.save(path)
        print(path, small.size)


if __name__ == "__main__":
    main(sys.argv[1])
