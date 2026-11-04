#!/usr/bin/env python3
"""Build dist/CursorPhreak-<version>-bsd.tar.gz: the GTK/WebKit build for FreeBSD, OpenBSD and friends.

Layout inside the archive:
  CursorPhreak-<v>-bsd/
    install.sh  README.txt  cursorphreak.py  cpcore.py
    app/renderer/...   (the same UI files as the Electron builds)
    app/fonts/...
    assets/catalog.json  previews.pak  frames.pak
"""
import io
import json
import os
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = json.load(open(os.path.join(ROOT, "package.json")))["version"]
NAME = "CursorPhreak-%s-bsd" % VERSION

README = """CursorPhreak %s for FreeBSD and OpenBSD
=========================================

Classic animated cursors for your desktop. Pick a category, click a cursor, and your mouse pointer changes.

1. Install the dependencies (Python 3 + PyGObject + GTK 3 + WebKitGTK):
     FreeBSD:  pkg install webkit2-gtk_41 devel/py-gobject3
     OpenBSD:  pkg_add webkitgtk41 py3-gobject3
2. ./install.sh            (installs into ~/.local; PREFIX=/usr/local ./install.sh as root for everyone)
3. Run "cursorphreak", or find CursorPhreak in your applications menu.

How it works: it writes a tiny Xcursor theme to ~/.icons/CursorPhreak-A (or -B) that replaces only the
arrow and inherits every other pointer from your current theme. Then it switches your desktop to that theme
(GNOME, KDE Plasma, Xfce, Cinnamon, MATE, Sway, Hyprland). On plain X11 window managers (cwm, fvwm, i3,
dwm, ...) it sets ~/.icons/default and the root window cursor instead.
Some already-open programs only show the new cursor after you restart them.

"Default Cursor" puts everything back. ./install.sh --uninstall removes the app.

Works on X11 and Wayland, and on Linux too. This is the same UI as the Windows/macOS/Linux builds,
hosted in WebKitGTK instead of Electron, because Electron has no OpenBSD port and no FreeBSD binary packages.
""" % VERSION


def main():
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", NAME + ".tar.gz")
    files = [
        ("bsd/install.sh", "install.sh", 0o755),
        ("bsd/cursorphreak.py", "cursorphreak.py", 0o755),
        ("bsd/cpcore.py", "cpcore.py", 0o644),
    ]
    for d, target in (("src/renderer", "app/renderer"), ("src/fonts", "app/fonts")):
        for f in sorted(os.listdir(os.path.join(ROOT, d))):
            files.append(("%s/%s" % (d, f), "%s/%s" % (target, f), 0o644))
    for f in ("catalog.json", "previews.pak", "frames.pak"):
        files.append(("assets/" + f, "assets/" + f, 0o644))

    with tarfile.open(out, "w:gz", compresslevel=9) as tar:
        def add_bytes(name, data, mode):
            ti = tarfile.TarInfo("%s/%s" % (NAME, name))
            ti.size, ti.mode, ti.uname, ti.gname, ti.mtime = len(data), mode, "root", "wheel", int(time.time())
            tar.addfile(ti, io.BytesIO(data))

        add_bytes("README.txt", README.encode(), 0o644)
        for src, dst, mode in files:
            with open(os.path.join(ROOT, src), "rb") as f:
                add_bytes(dst, f.read(), mode)
    print("%s (%.0f MB, %d files)" % (out, os.path.getsize(out) / 1e6, len(files) + 1))


if __name__ == "__main__":
    main()
