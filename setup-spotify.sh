#!/bin/sh
# Spotify widget setup for Linux / macOS: runs the local helper
# (tools/setup-helper.py) with Python 3, which every desktop distro and macOS ships.
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 tools/setup-helper.py "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python tools/setup-helper.py "$@"
fi
echo "Python 3 is needed for the automatic setup (for example: sudo apt install python3)."
echo "Or open tools/spotify-setup.html in Chrome/Chromium and use its 'Save into the widget folder' button."
exit 1
