#!/usr/bin/env python3
"""
Turn the CursorMania GIF archive into CursorPhreak's packed asset bundle.

Usage:  python3 -I tools/build_catalog.py "<path to CURSORMANIA ARCHIVE>" assets/

Output:
  assets/catalog.json  category tree + per-cursor metadata
  assets/previews.pak  concatenated preview images (original GIF, or fixed PNG/APNG)
  assets/frames.pak    concatenated zlib-compressed 32x32 RGBA frame stacks

Each cursor in catalog.json "c" is keyed by its archive id (the filename stem) and maps to
  [prevOff, prevLen, prevType(0=gif,1=png), frmOff, frmLen, nFrames, hotX, hotY, [delays ms...]]
"""
import io
import json
import os
import re
import sys
import zlib
from collections import deque

import numpy as np
from PIL import Image, ImageSequence

SIZE = 32
WHITE_MIN = 236  # min channel value counted as "background white" for the flood fill

# Display order of the top-level categories (Most Popular first, then alphabetical, like the original).
SPECIAL_NAMES = {
    "FANTASY - SCI-FI": "Fantasy/Sci-Fi",
    "NAMES - LETTER": "Names/Letters",
    "US STATES": "US States",
    "SEPT 11": "Sept. 11",
    "ST PATRICKS": "St. Patrick's",
    "NEW YEARS": "New Year's",
    "VALENTINES": "Valentine's",
    "CATS 1": "Cats",
    "UK": "UK",
    "NEW - FEATURED": "New/Featured",
}


def pretty(name: str) -> str:
    if name in SPECIAL_NAMES:
        return SPECIAL_NAMES[name]
    out = name.replace(" - ", "/")

    def cap(m):
        w = m.group(0)
        if len(w) == 1 and w.isalpha():
            return w.upper()  # keep single letters like A-I / F-L uppercase
        if w.lower() in ("and", "or", "of", "the") and m.start() > 0:
            return w.lower()
        return w[0].upper() + w[1:].lower()

    return re.sub(r"[A-Za-z']+", cap, out)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def sort_key_items(path):
    st = os.stat(path)
    stem = os.path.splitext(os.path.basename(path))[0]
    num = int(re.match(r"\d*", stem).group(0) or 0)
    return (int(st.st_mtime), num, stem)


def frames_rgba(im: Image.Image):
    frames, delays = [], []
    for fr in ImageSequence.Iterator(im):
        d = fr.info.get("duration", im.info.get("duration", 100)) or 0
        delays.append(100 if d <= 10 else int(d))
        frames.append(np.array(fr.convert("RGBA")))
    return frames, delays


def flood_white(a: np.ndarray) -> np.ndarray:
    """Make near-white pixels connected to the image border transparent."""
    h, w = a.shape[:2]
    white = (a[:, :, :3].min(axis=2) >= WHITE_MIN) & (a[:, :, 3] > 0)
    seen = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and white[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    out = a.copy()
    out[seen] = 0
    return out


def normalize(a: np.ndarray, lefty: bool) -> np.ndarray:
    """Fit a frame onto a 32x32 canvas, anchored to the pointer corner."""
    h, w = a.shape[:2]
    if h > SIZE or w > SIZE:
        s = max(h, w)
        sq = np.zeros((s, s, 4), np.uint8)
        if lefty:
            sq[:h, s - w:] = a
        else:
            sq[:h, :w] = a
        a = np.array(Image.fromarray(sq, "RGBA").resize((SIZE, SIZE), Image.NEAREST))
        h, w = SIZE, SIZE
    out = np.zeros((SIZE, SIZE, 4), np.uint8)
    if lefty:
        out[:h, SIZE - w:] = a
    else:
        out[:h, :w] = a
    return out


def hotspot(a: np.ndarray, lefty: bool):
    ys, xs = np.nonzero(a[:, :, 3])
    if len(xs) == 0:
        return (SIZE - 1 if lefty else 0), 0
    if lefty:
        score = (SIZE - 1 - xs) + ys
    else:
        score = xs + ys
    best = np.lexsort((ys, score))[0]
    return int(xs[best]), int(ys[best])


def encode_png(frames, delays):
    imgs = [Image.fromarray(f, "RGBA") for f in frames]
    buf = io.BytesIO()
    if len(imgs) == 1:
        imgs[0].save(buf, "PNG", optimize=True)
    else:
        imgs[0].save(buf, "PNG", save_all=True, append_images=imgs[1:], duration=delays, loop=0, disposal=1)
    return buf.getvalue()


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    tree = {}
    paths_by_id = {}
    for dirpath, dirs, files in os.walk(src):
        rel = os.path.relpath(dirpath, src)
        if rel == ".":
            continue
        parts = rel.split(os.sep)
        gifs = sorted((os.path.join(dirpath, f) for f in files if f.lower().endswith(".gif")), key=sort_key_items)
        ids = []
        for p in gifs:
            cid = os.path.splitext(os.path.basename(p))[0]
            paths_by_id.setdefault(cid, p)
            ids.append(cid)
        top = tree.setdefault(parts[0], {"items": [], "children": {}})
        if len(parts) == 1:
            top["items"] = ids
        else:
            top["children"]["/".join(parts[1:])] = ids

    # Which ids are lefties (hotspot top-right)
    lefty_ids = set(tree.get("LEFTIES", {}).get("items", []))
    for ids in tree.get("LEFTIES", {}).get("children", {}).values():
        lefty_ids.update(ids)

    cursors = {}
    stats = {"fixed": 0, "animated": 0, "resized": 0}
    with open(os.path.join(dst, "previews.pak"), "wb") as pv, open(os.path.join(dst, "frames.pak"), "wb") as fm:
        for i, (cid, p) in enumerate(sorted(paths_by_id.items())):
            raw = open(p, "rb").read()
            im = Image.open(io.BytesIO(raw))
            has_trans = "transparency" in im.info
            frames, delays = frames_rgba(im)
            if not has_trans:
                frames = [flood_white(f) for f in frames]
                stats["fixed"] += 1
            lefty = cid in lefty_ids
            if frames[0].shape[:2] != (SIZE, SIZE):
                stats["resized"] += 1
            frames = [normalize(f, lefty) for f in frames]
            # Drop consecutive duplicate frames (merge their delays) to keep cursors small.
            mf, md = [frames[0]], [delays[0]]
            for f, d in zip(frames[1:], delays[1:]):
                if np.array_equal(f, mf[-1]):
                    md[-1] += d
                else:
                    mf.append(f)
                    md.append(d)
            frames, delays = mf, md
            if len(frames) > 1:
                stats["animated"] += 1
            hx, hy = hotspot(frames[0], lefty)

            if has_trans:
                prev, ptype = raw, 0
            else:
                prev, ptype = encode_png(frames, delays), 1
            poff = pv.tell()
            pv.write(prev)
            blob = zlib.compress(b"".join(f.tobytes() for f in frames), 9)
            foff = fm.tell()
            fm.write(blob)
            cursors[cid] = [poff, len(prev), ptype, foff, len(blob), len(frames), hx, hy, delays]
            if i % 1000 == 0:
                print(f"  {i}/{len(paths_by_id)}", flush=True)

    def order_top(name):
        return (0 if name == "MOST POPULAR" else 1, pretty(name).lower())

    def order_child(name):
        return (1 if name.upper() == "OTHER" else 0, pretty(name).lower())

    cats = []
    for top in sorted(tree, key=order_top):
        node = tree[top]
        children = [
            {"n": pretty(c), "k": slug(top + "-" + c), "i": node["children"][c]}
            for c in sorted(node["children"], key=order_child)
        ]
        cats.append({"n": pretty(top), "k": slug(top), "i": node["items"], "c": children})

    with open(os.path.join(dst, "catalog.json"), "w") as f:
        json.dump({"v": 1, "size": SIZE, "cats": cats, "c": cursors}, f, separators=(",", ":"))
    print("cursors:", len(cursors), "categories:", len(cats), stats)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
