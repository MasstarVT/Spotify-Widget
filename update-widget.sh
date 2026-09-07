#!/bin/sh
# Downloads the newest release into this folder. settings.txt and your colour
# settings are kept; replaced files go to backup/ first (see setup-helper.py).
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 setup-helper.py --update "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python setup-helper.py --update "$@"
fi
echo "Python 3 is needed for the update (for example: sudo apt install python3)."
echo "Or download Widget.zip from the latest release and unzip it over this folder, keeping settings.txt."
exit 1
