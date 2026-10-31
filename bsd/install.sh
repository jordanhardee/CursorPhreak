#!/bin/sh
# CursorPhreak installer for FreeBSD, OpenBSD (and other Unix desktops) — GTK/WebKit build.
#   ./install.sh               install for the current user into ~/.local
#   PREFIX=/usr/local ./install.sh   (as root) install for everyone
#   ./install.sh --uninstall   remove it again
set -eu

PREFIX="${PREFIX:-$HOME/.local}"
DEST="$PREFIX/share/cursorphreak"
BIN="$PREFIX/bin"
APPS="$PREFIX/share/applications"
ICONS="$PREFIX/share/icons/hicolor/256x256/apps"
HERE=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = "--uninstall" ]; then
	rm -rf "$DEST" "$BIN/cursorphreak" "$APPS/cursorphreak.desktop" "$ICONS/cursorphreak.png"
	echo "CursorPhreak removed. (Click 'Default Cursor' in the app first if you want your old arrow back.)"
	exit 0
fi

CHECK='import gi
gi.require_version("Gtk", "3.0")
for v in ("4.1", "4.0"):
    try:
        gi.require_version("WebKit2", v)
        break
    except ValueError:
        pass
from gi.repository import Gtk, WebKit2'

PY=""
for cand in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python3.9; do
	p=$(command -v "$cand" 2>/dev/null || true)
	[ -n "$p" ] || continue
	if "$p" -c "$CHECK" >/dev/null 2>&1; then PY="$p"; break; fi
done

if [ -z "$PY" ]; then
	echo "CursorPhreak needs Python 3 with PyGObject, GTK 3 and WebKitGTK (API 4.1 or 4.0). Install them with:"
	case "$(uname -s)" in
	FreeBSD | DragonFly) echo "    pkg install webkit2-gtk_41 devel/py-gobject3" ;;
	OpenBSD) echo "    pkg_add webkitgtk41 py3-gobject3" ;;
	NetBSD) echo "    the PyGObject 3 and WebKitGTK packages from pkgsrc" ;;
	Linux)
		echo "    Debian/Ubuntu: apt install python3-gi gir1.2-webkit2-4.1"
		echo "    Fedora:        dnf install python3-gobject webkit2gtk4.1"
		echo "    Arch:          pacman -S python-gobject webkit2gtk-4.1"
		;;
	*) echo "    PyGObject and WebKitGTK from your package manager" ;;
	esac
	echo "Then run ./install.sh again."
	exit 1
fi

mkdir -p "$DEST" "$BIN" "$APPS" "$ICONS"
rm -rf "$DEST/app" "$DEST/assets"
cp "$HERE/cursorphreak.py" "$HERE/cpcore.py" "$DEST/"
cp -R "$HERE/app" "$HERE/assets" "$DEST/"
cp "$HERE/app/renderer/icon.png" "$ICONS/cursorphreak.png"

cat >"$BIN/cursorphreak" <<EOF
#!/bin/sh
exec "$PY" "$DEST/cursorphreak.py" "\$@"
EOF
chmod 755 "$BIN/cursorphreak"

cat >"$APPS/cursorphreak.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=CursorPhreak
Comment=Classic CursorMania cursors for your desktop
Exec=$BIN/cursorphreak
Icon=$ICONS/cursorphreak.png
Categories=Utility;Settings;DesktopSettings;
StartupWMClass=CursorPhreak
EOF

echo "CursorPhreak installed (using $PY)."
case ":$PATH:" in
*":$BIN:"*) echo "Start it with: cursorphreak  (or from your applications menu)" ;;
*) echo "Start it with: $BIN/cursorphreak  (or add $BIN to your PATH)" ;;
esac
