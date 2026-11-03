#!/usr/bin/env python3
"""CursorPhreak for FreeBSD, OpenBSD and other Unix desktops without Electron.

A small GTK 3 + WebKitGTK window that hosts the exact same UI as the Electron build
(src/renderer) and answers its `window.cp` calls with cpcore.py instead of Electron's main process.

Needs: Python 3, PyGObject, GTK 3 and WebKitGTK (API 4.1 or 4.0).
  FreeBSD:  pkg install webkit2-gtk_41 devel/py-gobject3
  OpenBSD:  pkg_add webkitgtk41 py3-gobject3
"""
import json
import os
import subprocess
import sys
from urllib.parse import quote, unquote, urlparse

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
for _v in ("4.1", "4.0"):
    try:
        gi.require_version("WebKit2", _v)
        break
    except ValueError:
        continue
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import cpcore  # noqa: E402

WIDTH, HEIGHT = 426, 530
# The original's title bar: drag anywhere in the top strip except on the X button.
TITLE_H = 48
CLOSE_BTN = (385, 11, 415, 39)

BRIDGE_JS = r"""
(() => {
  let next = 0;
  const pending = new Map();
  window.__cpReply = (id, ok, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(value) : p.reject(new Error(value));
  };
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    window.webkit.messageHandlers.cp.postMessage(JSON.stringify({ id, method, args }));
  });
  window.cp = {
    catalog: () => call('catalog'),
    apply: (id) => call('apply', id),
    restore: () => call('restore'),
    snippet: (id) => call('snippet', id),
    favorite: (id, on) => call('favorite', id, on),
    copy: (text) => call('copy', text),
    mail: () => call('mail'),
    close: () => call('close'),
    minimize: () => call('minimize'),
  };
})();
"""

MAIL_URI = "mailto:?subject=%s&body=%s" % (
    quote("Check out CursorPhreak!"),
    quote("I just found CursorPhreak: over 11,000 classic CursorMania cursors for Windows, Mac, Linux and BSD. "
          "One click and your mouse pointer is a sparkly rainbow arrow (or a pig, or a pizza)."),
)


def find_app_files():
    """Installed layout (app/renderer + assets next to this file) or the source tree (../src/renderer + ../assets)."""
    for renderer, assets in (
        (os.path.join(HERE, "app", "renderer"), os.path.join(HERE, "assets")),
        (os.path.join(HERE, "..", "src", "renderer"), os.path.join(HERE, "..", "assets")),
    ):
        if os.path.isfile(os.path.join(renderer, "index.html")) and os.path.isfile(os.path.join(assets, "catalog.json")):
            return os.path.realpath(renderer), os.path.realpath(assets)
    sys.exit("CursorPhreak: can't find the app files (app/renderer and assets) next to %s" % HERE)


class CursorPhreak:
    def __init__(self):
        renderer, assets = find_app_files()
        self.backend = cpcore.Backend(assets)
        self.index_uri = GLib.filename_to_uri(os.path.join(renderer, "index.html"), None)

        # --- WebKit context: serve cursor previews on cp://p/<id>, like Electron's protocol.handle
        ctx = WebKit2.WebContext.get_default()
        ctx.register_uri_scheme("cp", self.on_cp_request)
        sm = ctx.get_security_manager()
        sm.register_uri_scheme_as_secure("cp")
        sm.register_uri_scheme_as_cors_enabled("cp")

        ucm = WebKit2.UserContentManager()
        ucm.add_script(WebKit2.UserScript(BRIDGE_JS, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                                          WebKit2.UserScriptInjectionTime.START, None, None))
        ucm.connect("script-message-received::cp", self.on_message)
        ucm.register_script_message_handler("cp")

        self.view = WebKit2.WebView.new_with_user_content_manager(ucm)
        s = self.view.get_settings()
        s.set_allow_file_access_from_file_urls(True)
        s.set_enable_developer_extras(bool(os.environ.get("CP_DEVTOOLS")))
        s.set_enable_write_console_messages_to_stdout(bool(os.environ.get("CP_DEBUG")))
        try:  # a 426x530 window doesn't need the GPU; software rendering is the most reliable on BSD drivers
            s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
        except Exception:
            pass
        self.view.connect("context-menu", lambda *a: True)
        self.view.connect("decide-policy", self.on_policy)
        self.view.connect("button-press-event", self.on_button_press)
        self.view.connect("load-changed", self.on_load_changed)

        # --- frameless window with see-through rounded corners when a compositor is running
        self.win = Gtk.Window(title="CursorPhreak")
        self.win.set_wmclass("cursorphreak", "CursorPhreak")
        self.win.set_decorated(False)
        self.win.set_resizable(False)
        self.win.set_size_request(WIDTH, HEIGHT)
        self.win.set_default_size(WIDTH, HEIGHT)
        self.win.set_position(Gtk.WindowPosition.CENTER)
        icon = os.path.join(renderer, "icon.png")
        if os.path.exists(icon):
            self.win.set_icon_from_file(icon)
        screen = self.win.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None and screen.is_composited():
            self.win.set_visual(visual)
            self.win.set_app_paintable(True)
            self.view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        else:
            self.view.set_background_color(Gdk.RGBA(0.49, 0.56, 0.60, 1))  # matches the window's edge colour
        self.win.add(self.view)
        self.win.connect("destroy", Gtk.main_quit)
        self.view.load_uri(self.index_uri)
        self.win.show_all()

    # ---------------------------------------------------------------- web plumbing
    def on_cp_request(self, req):
        u = urlparse(req.get_uri())
        found = self.backend.catalog.preview(unquote(u.path.lstrip("/"))) if u.netloc == "p" else None
        if not found:
            req.finish_error(GLib.Error.new_literal(Gio.io_error_quark(), "not found", int(Gio.IOErrorEnum.NOT_FOUND)))
            return
        data, mime = found
        req.finish(Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data)), len(data), mime)

    def on_policy(self, view, decision, kind):
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if uri != self.index_uri:
                decision.ignore()
                return True
        elif kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
            decision.ignore()
            return True
        return False

    def on_button_press(self, view, ev):
        if ev.button == 1 and ev.type == Gdk.EventType.BUTTON_PRESS and ev.y < TITLE_H:
            x0, y0, x1, y1 = CLOSE_BTN
            if not (x0 <= ev.x <= x1 and y0 <= ev.y <= y1):
                self.win.begin_move_drag(ev.button, int(ev.x_root), int(ev.y_root), ev.time)
                return True
        return False

    def run_js(self, script):
        if hasattr(self.view, "evaluate_javascript"):
            self.view.evaluate_javascript(script, -1, None, None, None, None, None)
        else:
            self.view.run_javascript(script, None, None, None)

    def reply(self, msg_id, ok, value):
        self.run_js("window.__cpReply(%d, %s, %s)" % (msg_id, "true" if ok else "false", json.dumps(value)))

    def on_message(self, manager, result):
        value = result.get_js_value() if hasattr(result, "get_js_value") else result
        try:
            msg = json.loads(value.to_string())
        except Exception:
            return
        msg_id, method, args = msg.get("id", 0), msg.get("method"), msg.get("args") or []
        try:
            self.reply(msg_id, True, self.dispatch(method, args))
        except Exception as e:  # shown to the user by the page's error dialog
            self.reply(msg_id, False, str(e) or e.__class__.__name__)

    # ---------------------------------------------------------------- the window.cp API
    def dispatch(self, method, args):
        b = self.backend
        if method == "catalog":
            return b.catalog_info()
        if method == "apply":
            return b.apply(str(args[0]))
        if method == "restore":
            return b.restore()
        if method == "snippet":
            return b.snippet(str(args[0]))
        if method == "favorite":
            return b.favorite(str(args[0]), bool(args[1]))
        if method == "copy":
            cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            cb.set_text(str(args[0]), -1)
            cb.store()
            return True
        if method == "mail":
            try:
                Gio.AppInfo.launch_default_for_uri(MAIL_URI, None)
            except Exception:
                subprocess.Popen(["xdg-open", MAIL_URI], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        if method == "close":
            GLib.idle_add(Gtk.main_quit)
            return True
        if method == "minimize":
            self.win.iconify()
            return True
        raise ValueError("Unknown call %s" % method)

    # ---------------------------------------------------------------- dev-only screenshot hook (used by tests)
    def on_load_changed(self, view, event):
        shot = os.environ.get("CP_SCREENSHOT")
        if event != WebKit2.LoadEvent.FINISHED or not shot:
            return

        def capture():
            def done(v, res):
                surface = v.get_snapshot_finish(res)
                surface.write_to_png(shot)
                Gtk.main_quit()

            self.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.TRANSPARENT_BACKGROUND, None, done)
            return False

        def act():
            if os.environ.get("CP_SCREENSHOT_JS"):
                self.run_js(os.environ["CP_SCREENSHOT_JS"])
            GLib.timeout_add(int(os.environ.get("CP_SCREENSHOT_WAIT", "1500")), capture)
            return False

        GLib.timeout_add(1500, act)


def main():
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        sys.exit("CursorPhreak needs a graphical session (X11 or Wayland).")
    GLib.set_prgname("cursorphreak")
    GLib.set_application_name("CursorPhreak")
    CursorPhreak()
    Gtk.main()


if __name__ == "__main__":
    main()
