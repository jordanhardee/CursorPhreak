"""CursorPhreak core for FreeBSD / OpenBSD (and any X11/Wayland Unix). No GUI code in here.

A line-for-line port of the Electron app's src/catalog.js, src/encoders.js (Xcursor + PNG) and
src/platform/linux.js. It writes the same files and the same state.json, so it behaves exactly
like the Linux build: a tiny Xcursor theme that replaces only the arrow and inherits everything
else from the user's current theme.
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zlib
import base64

THEME_PREFIX = "CursorPhreak"
ARROW_NAMES = ["left_ptr", "default", "arrow", "top_left_arrow", "left-arrow"]
XCURSOR_IMAGE_TYPE = 0xFFFD0002


def platform_name():
    p = sys.platform
    for name in ("freebsd", "openbsd", "netbsd", "dragonfly", "linux"):
        if p.startswith(name):
            return name
    return p


# ---------------------------------------------------------------- catalog
class Catalog:
    def __init__(self, directory):
        with open(os.path.join(directory, "catalog.json"), encoding="utf-8") as f:
            data = json.load(f)
        self.size = data["size"]
        self.cats = data["cats"]
        self.cursors = data["c"]
        self._prev = open(os.path.join(directory, "previews.pak"), "rb")
        self._frames = open(os.path.join(directory, "frames.pak"), "rb")

    def has(self, cid):
        return cid in self.cursors

    def preview(self, cid):
        e = self.cursors.get(cid)
        if not e:
            return None
        self._prev.seek(e[0])
        return self._prev.read(e[1]), ("image/gif" if e[2] == 0 else "image/png")

    def cursor(self, cid):
        e = self.cursors.get(cid)
        if not e:
            raise KeyError("Unknown cursor %s" % cid)
        self._frames.seek(e[3])
        raw = zlib.decompress(self._frames.read(e[4]))
        fsz = self.size * self.size * 4
        frames = [raw[i * fsz:(i + 1) * fsz] for i in range(e[5])]
        return {"id": cid, "w": self.size, "h": self.size, "frames": frames, "hx": e[6], "hy": e[7], "delays": e[8]}


# ---------------------------------------------------------------- encoders
def scale_nearest(rgba, w, h, f):
    if f == 1:
        return rgba
    out = bytearray(w * f * h * f * 4)
    W = w * f
    for y in range(h * f):
        sy = (y // f) * w
        for x in range(W):
            s = (sy + x // f) * 4
            d = (y * W + x) * 4
            out[d:d + 4] = rgba[s:s + 4]
    return bytes(out)


def xcursor_file(frames, delays, w, h, hx, hy, scales=(2, 1)):
    """Same layout, byte for byte, as encoders.js xcursorFile()."""
    images = []
    for s in scales:
        for i, fr in enumerate(frames):
            images.append((w * s, w * s, h * s, hx * s, hy * s, delays[i] if len(frames) > 1 else 0, scale_nearest(fr, w, h, s)))
    header = 16
    pos = header + len(images) * 12
    toc, chunks = [], []
    for nominal, iw, ih, ihx, ihy, delay, rgba in images:
        px = bytearray(iw * ih * 4)
        for p in range(iw * ih):
            r, g, b, a = rgba[p * 4:p * 4 + 4]
            # premultiplied ARGB little-endian => B, G, R, A (JS Math.round == round half up here)
            px[p * 4] = (b * a + 127) // 255 if a not in (0, 255) else (b if a else 0)
            px[p * 4 + 1] = (g * a + 127) // 255 if a not in (0, 255) else (g if a else 0)
            px[p * 4 + 2] = (r * a + 127) // 255 if a not in (0, 255) else (r if a else 0)
            px[p * 4 + 3] = a
        chunk = struct.pack("<9I", 36, XCURSOR_IMAGE_TYPE, nominal, 1, iw, ih, ihx, ihy, delay) + bytes(px)
        toc.append(struct.pack("<3I", XCURSOR_IMAGE_TYPE, nominal, pos))
        chunks.append(chunk)
        pos += len(chunk)
    return b"Xcur" + struct.pack("<3I", header, 0x00010000, len(images)) + b"".join(toc) + b"".join(chunks)


def png_file(rgba, w, h):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def _frame_urls(cur):
    return ["data:image/png;base64," + base64.b64encode(png_file(f, cur["w"], cur["h"])).decode() for f in cur["frames"]]


def css_snippet(cur):
    """Same as src/snippets.js cssSnippet(): a @keyframes animation on `cursor`, no external files."""
    urls = _frame_urls(cur)

    def at(u):
        return "url(%s) %d %d,auto" % (u, cur["hx"], cur["hy"])

    tag = "<!-- CursorPhreak cursor #%s -->" % cur["id"]
    if len(urls) == 1:
        return '<style type="text/css">html{cursor:%s}html *{cursor:inherit!important}</style>%s' % (at(urls[0]), tag)
    total = sum(cur["delays"])
    steps, t = [], 0
    for u, d in zip(urls, cur["delays"]):
        pct = round(t / total * 100, 3)
        steps.append("%s%%{cursor:%s}" % (("%g" % pct), at(u)))
        t += d
    steps.append("100%%{cursor:%s}" % at(urls[-1]))
    return ('<style type="text/css">@keyframes cphreak{%s}html{cursor:%s;animation:cphreak %dms step-end infinite}'
            "html *{cursor:inherit!important}</style>%s" % ("".join(steps), at(urls[0]), total, tag))


def js_snippet(cur):
    """Same as src/snippets.js jsSnippet(): swaps the cursor on a timer, each distinct image stored once."""
    urls = _frame_urls(cur)
    uniq = list(dict.fromkeys(urls))
    order = [uniq.index(u) for u in urls]
    dumps = lambda v: json.dumps(v, separators=(",", ":"))  # noqa: E731
    return ('<script>/* CursorPhreak cursor #%s */(function(){var f=%s,q=%s,d=%s,i=0,s=document.createElement("style");'
            "(document.head||document.documentElement).appendChild(s);"
            'function n(){s.textContent="html,html *{cursor:url("+f[q[i]]+") %d %d,auto!important}";'
            "if(q.length>1){setTimeout(n,d[i]);i=(i+1)%%q.length}}n()})();</script>"
            % (cur["id"], dumps(uniq), dumps(order), dumps(cur["delays"]), cur["hx"], cur["hy"]))


def snippet(catalog, cid):
    cur = catalog.cursor(cid)
    return {"css": css_snippet(cur), "js": js_snippet(cur)}


# ---------------------------------------------------------------- desktop integration
def run(cmd, args):
    try:
        out = subprocess.run([cmd] + list(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=8, check=True)
        return out.stdout.decode("utf-8", "replace").strip()
    except Exception:
        return None


def has(cmd):
    return shutil.which(cmd) is not None


def desktop():
    return ("%s:%s" % (os.environ.get("XDG_CURRENT_DESKTOP", ""), os.environ.get("DESKTOP_SESSION", ""))).lower()


def unquote(s):
    return re.sub(r"^'(.*)'$", r"\1", s).strip() if s else s


def cursor_size():
    g = run("gsettings", ["get", "org.gnome.desktop.interface", "cursor-size"]) if has("gsettings") else None
    try:
        n = int(g or os.environ.get("XCURSOR_SIZE") or "24")
        return n if n > 0 else 24
    except ValueError:
        return 24


def icon_dirs():
    home = os.path.expanduser("~")
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local/share")
    data_dirs = (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")
    # BSD ports install under /usr/local; OpenBSD's X (Xenocara) keeps its themes under /usr/X11R6.
    return ([os.path.join(home, ".icons"), os.path.join(data_home, "icons")] + [os.path.join(d, "icons") for d in data_dirs]
            + ["/usr/local/share/pixmaps", "/usr/share/pixmaps", "/usr/X11R6/share/icons", "/usr/local/lib/X11/icons"])


def theme_exists(name):
    return any(os.path.exists(os.path.join(d, name, "cursors")) or os.path.exists(os.path.join(d, name, "index.theme")) for d in icon_dirs())


def read_ini(path, key):
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"^\s*%s\s*=\s*(.+)$" % re.escape(key), f.read(), re.M)
        return m.group(1).strip() if m else None
    except OSError:
        return None


def detect_current_theme():
    d = desktop()
    home = os.path.expanduser("~")
    c = []
    if "kde" in d or "plasma" in d:
        c.append(run("kreadconfig6", ["--file", "kcminputrc", "--group", "Mouse", "--key", "cursorTheme"]))
        c.append(run("kreadconfig5", ["--file", "kcminputrc", "--group", "Mouse", "--key", "cursorTheme"]))
        c.append(read_ini(os.path.join(home, ".config/kcminputrc"), "cursorTheme"))
    if "xfce" in d:
        c.append(run("xfconf-query", ["-c", "xsettings", "-p", "/Gtk/CursorThemeName"]))
    if "cinnamon" in d:
        c.append(unquote(run("gsettings", ["get", "org.cinnamon.desktop.interface", "cursor-theme"])))
    if "mate" in d:
        c.append(unquote(run("gsettings", ["get", "org.mate.peripherals-mouse", "cursor-theme"])))
    if has("gsettings"):
        c.append(unquote(run("gsettings", ["get", "org.gnome.desktop.interface", "cursor-theme"])))
    c.append(os.environ.get("XCURSOR_THEME"))
    c.append(read_ini(os.path.join(home, ".icons/default/index.theme"), "Inherits"))
    c.append(read_ini(os.path.join(home, ".config/gtk-3.0/settings.ini"), "gtk-cursor-theme-name"))
    for x in c:
        if x and not x.startswith(THEME_PREFIX):
            return x
    for fallback in ("Adwaita", "breeze_cursors", "DMZ-White", "whiteglass", "default"):
        if theme_exists(fallback):
            return fallback
    return "Adwaita"


def set_theme(theme, size):
    d = desktop()
    done = []

    def try_run(label, cmd, args):
        if has(cmd) and run(cmd, args) is not None:
            done.append(label)

    if "kde" in d or "plasma" in d:
        try_run("plasma", "plasma-apply-cursortheme", [theme])
        if "plasma" not in done:
            try_run("kwriteconfig6", "kwriteconfig6", ["--file", "kcminputrc", "--group", "Mouse", "--key", "cursorTheme", theme])
            try_run("kwriteconfig5", "kwriteconfig5", ["--file", "kcminputrc", "--group", "Mouse", "--key", "cursorTheme", theme])
    if "xfce" in d:
        try_run("xfconf", "xfconf-query", ["-c", "xsettings", "-p", "/Gtk/CursorThemeName", "-s", theme])
    if "cinnamon" in d:
        try_run("cinnamon", "gsettings", ["set", "org.cinnamon.desktop.interface", "cursor-theme", theme])
    if "mate" in d:
        try_run("mate", "gsettings", ["set", "org.mate.peripherals-mouse", "cursor-theme", theme])
    if "hyprland" in d or os.environ.get("HYPRLAND_INSTANCE_SIGNATURE"):
        try_run("hyprland", "hyprctl", ["setcursor", theme, str(size)])
    if "sway" in d or os.environ.get("SWAYSOCK"):
        try_run("sway", "swaymsg", ["seat", "*", "xcursor_theme", theme, str(size)])
    try_run("gnome", "gsettings", ["set", "org.gnome.desktop.interface", "cursor-theme", theme])
    return done


GNOME_LIKE = re.compile(r"gnome|unity|budgie|pantheon|cosmic|ubuntu|pop|deepin|kde|plasma|xfce|cinnamon|mate|hyprland|sway")


class Platform:
    """Same behaviour and state layout as src/platform/linux.js."""

    def __init__(self, state, save_state):
        self.state = state
        self.save = save_state
        self.icons_root = os.path.join(os.path.expanduser("~"), ".icons")
        self.default_index = os.path.join(self.icons_root, "default", "index.theme")
        self.name = platform_name()

    def _write_theme(self, slot, cur, base):
        name = "%s-%s" % (THEME_PREFIX, slot)
        d = os.path.join(self.icons_root, name)
        cdir = os.path.join(d, "cursors")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(cdir)
        with open(os.path.join(d, "index.theme"), "w", encoding="utf-8") as f:
            f.write("[Icon Theme]\nName=%s\nComment=CursorPhreak cursor %s (over %s)\nInherits=%s\n" % (name, cur["id"], base, base))
        with open(os.path.join(cdir, ARROW_NAMES[0]), "wb") as f:
            f.write(xcursor_file(cur["frames"], cur["delays"], cur["w"], cur["h"], cur["hx"], cur["hy"], (2, 1)))
        for alias in ARROW_NAMES[1:]:
            os.symlink(ARROW_NAMES[0], os.path.join(cdir, alias))
        return name

    def apply(self, cur):
        st = self.state
        if not st.get("linux"):
            st["linux"] = {"baseTheme": detect_current_theme(), "slot": "B"}
        base = st["linux"]["baseTheme"]
        slot = "B" if st["linux"]["slot"] == "A" else "A"
        theme = self._write_theme(slot, cur, base)
        size = cursor_size()
        used = set_theme(theme, size)
        gnome_like = bool(GNOME_LIKE.search(desktop()))
        if not [u for u in used if u != "gnome" or gnome_like]:
            # Plain X11 window manager (cwm, fvwm, i3, ... the usual BSD setups)
            if not st["linux"].get("touchedDefaultIndex"):
                st["linux"]["touchedDefaultIndex"] = True
                prev = None
                if os.path.exists(self.default_index):
                    with open(self.default_index, encoding="utf-8") as f:
                        prev = f.read()
                st["linux"]["previousDefaultIndex"] = prev
            os.makedirs(os.path.dirname(self.default_index), exist_ok=True)
            with open(self.default_index, "w", encoding="utf-8") as f:
                f.write("[Icon Theme]\nInherits=%s\n" % theme)
            if has("xsetroot"):
                run("xsetroot", ["-xcf", os.path.join(self.icons_root, theme, "cursors", "left_ptr"), str(size)])
            used.append("x11-default")
        st["linux"]["slot"] = slot
        self.save()
        shutil.rmtree(os.path.join(self.icons_root, "%s-%s" % (THEME_PREFIX, "B" if slot == "A" else "A")), ignore_errors=True)
        return {"theme": theme, "base": base, "via": used}

    def restore(self):
        st = self.state
        if not st.get("linux"):
            return {}
        lx = st["linux"]
        set_theme(lx["baseTheme"], cursor_size())
        if lx.get("touchedDefaultIndex"):
            prev = lx.get("previousDefaultIndex")
            if prev is None:
                try:
                    os.remove(self.default_index)
                except OSError:
                    pass
            else:
                with open(self.default_index, "w", encoding="utf-8") as f:
                    f.write(prev)
            if has("xsetroot"):
                run("xsetroot", ["-cursor_name", "left_ptr"])
        del st["linux"]
        self.save()
        for s in ("A", "B"):
            shutil.rmtree(os.path.join(self.icons_root, "%s-%s" % (THEME_PREFIX, s)), ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(self.default_index))
        except OSError:
            pass
        return {}


# ---------------------------------------------------------------- app backend (what Electron's main.js does)
class Backend:
    def __init__(self, assets_dir):
        self.catalog = Catalog(assets_dir)
        cfg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
        self.state_path = os.path.join(cfg, "CursorPhreak", "state.json")  # same file as the Electron Linux build
        try:
            with open(self.state_path, encoding="utf-8") as f:
                self.state = json.load(f)
        except (OSError, ValueError):
            self.state = {}
        self.platform = Platform(self.state, self.save_state)

    def save_state(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=2)
        os.replace(tmp, self.state_path)

    # IPC methods, same names and results as the Electron preload API
    def catalog_info(self):
        return {"cats": self.catalog.cats, "current": self.state.get("current"), "platform": self.platform.name}

    def apply(self, cid):
        if not self.catalog.has(cid):
            raise ValueError("Unknown cursor")
        res = self.platform.apply(self.catalog.cursor(cid))
        self.state["current"] = cid
        self.save_state()
        res.update({"ok": True, "snippet": snippet(self.catalog, cid)})
        return res

    def restore(self):
        res = self.platform.restore() or {}
        self.state.pop("current", None)
        self.save_state()
        res["ok"] = True
        return res

    def snippet(self, cid):
        return snippet(self.catalog, cid) if self.catalog.has(cid) else None
