#!/usr/bin/env bash
# Rebuild a tauri/linuxdeploy AppImage so it runs against the system
# WebKit2GTK + GTK 3 stack instead of the bundled one.
#
# Why: linuxdeploy bundles the CI image's libwebkit2gtk-4.1 (Ubuntu 22.04),
# gstreamer, glib and gtk3 into the AppImage. On modern distros that bundled
# WebKit dies during EGL init — "Could not create default EGL display:
# EGL_BAD_PARAMETER. Aborting..." — leaving a blank window (reproduced on
# CachyOS + KDE Wayland + Mesa 26; WebKit bug 297921, same reports for other
# Tauri AppImages). The system WebKit renders fine, and the deb/rpm bundles
# already depend on the system stack, so the AppImage is repacked "thin":
# every bundled shared library and WebKit helper is dropped and a minimal
# AppRun replaces the linuxdeploy one (whose GTK hook points GTK module
# caches at the now-removed bundled modules and would break input methods).
#
# Resulting AppImage requires webkit2gtk-4.1 + gtk3 + gstreamer on the host.
#
# Usage: slim-appimage.sh <input.AppImage> [output.AppImage]
#   output defaults to <input>-slim.AppImage; pass the input path to replace
#   it in place (used by CI before re-signing the updater artifact).
#
# Needs: bash, curl (only to fetch appimagetool when absent), FUSE or
# APPIMAGE_EXTRACT_AND_RUN for the AppImage runtime.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <input.AppImage> [output.AppImage]" >&2
  exit 2
fi

input="$(readlink -f "$1")"
output="${2:-"${input%.AppImage}-slim.AppImage"}"
case "$output" in
  /*) ;;
  *) output="$PWD/$output" ;;
esac

[ -f "$input" ] || { echo "error: no such file: $input" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- extract ---------------------------------------------------------------
( cd "$work" && "$input" --appimage-extract >/dev/null )
appdir="$work/squashfs-root"
[ -x "$appdir/usr/bin/ompcot" ] || { echo "error: usr/bin/ompcot missing in AppImage" >&2; exit 1; }
[ -d "$appdir/usr/lib/Ompcot" ] || { echo "error: usr/lib/Ompcot missing in AppImage" >&2; exit 1; }

# --- strip every bundled shared library / GTK / WebKit payload -------------
# Only data and the app's own payload (usr/lib/Ompcot) must survive: anything
# ABI-sensitive that stays in the bundle can shadow the system library of the
# same soname via the runtime's LD_LIBRARY_PATH prefix.
rm -f "$appdir"/usr/lib/*.so*
rm -rf "$appdir/usr/lib/x86_64-linux-gnu" \
       "$appdir/usr/lib/gtk-3.0" \
       "$appdir/usr/lib/gdk-pixbuf-2.0" \
       "$appdir/usr/lib/girepository-1.0" \
       "$appdir/apprun-hooks" \
       "$appdir/AppRun.wrapped"

# The thin bundle is only as good as the host's library set: fail loudly at
# build time if anything the binary links is unresolvable on this machine.
missing="$(ldd "$appdir/usr/bin/ompcot" | grep 'not found' || true)"
if [ -n "$missing" ]; then
  echo "error: system is missing libraries the app needs (install webkit2gtk-4.1 / gtk3 / gstreamer):" >&2
  echo "$missing" >&2
  exit 1
fi

# --- minimal AppRun --------------------------------------------------------
# Deliberately no linuxdeploy GTK hook: with the bundled GTK gone its
# GTK_IM_MODULE_FILE / GDK_PIXBUF_MODULE_FILE / GSETTINGS_SCHEMA_DIR values
# point at stale caches and break input methods and theming. System GTK is
# configured by the system.
cat > "$appdir/AppRun" <<'EOF'
#! /bin/sh
# Slim AppRun (scripts/slim-appimage.sh): system GTK/WebKit, no bundled libs.
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="${APPDIR:-"$HERE"}"
exec "$HERE/usr/bin/ompcot" "$@"
EOF
chmod +x "$appdir/AppRun"

# --- repack ----------------------------------------------------------------
appimagetool_bin="${APPIMAGETOOL:-}"
if [ -z "$appimagetool_bin" ]; then
  appimagetool_bin="$(command -v appimagetool || true)"
fi
if [ -z "$appimagetool_bin" ]; then
  appimagetool_bin="$work/appimagetool"
  # Match the runner's architecture: an x86_64 appimagetool cannot execute
  # on the arm64 runners (Exec format error).
  case "$(uname -m)" in
    aarch64 | arm64) at_arch=aarch64 ;;
    *) at_arch=x86_64 ;;
  esac
  curl -sL -o "$appimagetool_bin" \
    "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${at_arch}.AppImage"
  chmod +x "$appimagetool_bin"
fi

rm -f "$output"
# APPIMAGE_EXTRACT_AND_RUN: CI runners cannot FUSE-mount appimagetool.
APPIMAGE_EXTRACT_AND_RUN=1 "$appimagetool_bin" --no-appstream "$appdir" "$output" >/dev/null
chmod +x "$output"

echo "slim AppImage written: $output"
