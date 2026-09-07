#!/usr/bin/env python3
"""setup-helper.py - local helper for the Spotify widget (Linux / macOS).

Lives in tools/ next to spotify-setup.html; the widget folder is the parent.

Started by setup-spotify.sh: runs a tiny web server on 127.0.0.1:8888 that
serves spotify-setup.html, receives Spotify's redirect, and writes
settings.txt into the widget folder, so the setup finishes without copying
URLs or picking folders. It only listens on this computer (127.0.0.1), only
serves the setup page, and only writes settings.txt. Press Ctrl+C or close
the terminal to stop it.

Started by update-widget.sh (--update): downloads the newest release and
replaces the files in the widget folder. settings.txt is never touched, the
colour block (:root) at the top of each widget file keeps your values, and
every file that is replaced is copied to backup/<version>/ first.
"""
import argparse
import http.server
import io
import json
import os
import re
import secrets
import shutil
import ssl
import sys
import time
import urllib.request
import webbrowser
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))     # tools/
ROOT = os.path.dirname(HERE)                           # the widget folder
if (not os.path.exists(os.path.join(ROOT, 'now-playing-source.js')) and
        os.path.exists(os.path.join(HERE, 'now-playing-source.js'))):
    ROOT = HERE                                        # a copy placed next to the widgets (the layout before tools/)
PAGE = os.path.join(HERE, 'spotify-setup.html')
SETTINGS = os.path.join(ROOT, 'settings.txt')
SOURCE = os.path.join(ROOT, 'now-playing-source.js')
UPDATE_URL = 'https://masstarvt.github.io/Spotify-Widget/'         # where releases are published
KEEP = ('settings.txt',)                                           # never replaced by an update
STALE = ('setup-helper.py', 'setup-helper.ps1', 'spotify-setup.html')   # top-level copies from before tools/
TOKEN = secrets.token_hex(16)
PORT = 8888
SAVED = False


# ── versions ───────────────────────────────────────────────────────────────

def update_url():
    """update_url from settings.txt (same rule as the widget), else the default."""
    url = UPDATE_URL
    try:
        with open(SETTINGS, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, val = line.split('=', 1)
                if key.strip().lower() == 'update_url':
                    val = re.sub(r'\s#.*$', '', val).strip()
                    if re.match(r'^https?://', val, re.I):
                        url = val
    except OSError:
        pass
    return url if url.endswith('/') else url + '/'


def stamp_of(js):
    """WIDGET_VERSION as written in a copy of now-playing-source.js ('' if none)."""
    m = re.search(r"WIDGET_VERSION\s*=\s*'([^']*)'", js or '')
    return m.group(1) if m else ''


def local_stamp():
    try:
        with open(SOURCE, encoding='utf-8', errors='replace') as f:
            return stamp_of(f.read())
    except OSError:
        return ''


def local_version():
    """The release version of the files here ('' for a working copy or unknown)."""
    v = local_stamp()
    return '' if v.startswith('$Format') else v


def version_number(s):
    m = re.match(r'^v(\d+)', (s or '').strip(), re.I)
    return int(m.group(1)) if m else None


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'spotify-widget-update'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def explain(e):
    reason = getattr(e, 'reason', e)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return ('%s. On macOS, run "Install Certificates.command" from the Python folder once' % reason)
    return str(e)


# ── update ─────────────────────────────────────────────────────────────────

def merge_root(old, new):
    """Carry the values of the old file's :root block (the customisation
    block at the top of every widget) into the new file: same names take
    the old value, names the new file does not know are added."""
    pat = re.compile(r':root\s*\{[^}]*\}')
    mo, mn = pat.search(old), pat.search(new)
    if not mo or not mn:
        return new
    eol = '\r\n' if '\r\n' in new else '\n'
    block = mn.group(0)
    for name, val in re.findall(r'(--[\w-]+)\s*:\s*([^;]*);', mo.group(0)):
        val = val.strip()
        m = re.compile(r'(%s)(\s*:\s*)([^;]*);' % re.escape(name)).search(block)
        if m:
            if m.group(3).strip() != val:            # keep the line's own spacing, only swap the value
                block = block[:m.start()] + m.group(1) + m.group(2) + val + ';' + block[m.end():]
        else:
            block = block[:-1].rstrip() + eol + '    %s: %s;' % (name, val) + eol + '  }'
    return new[:mn.start()] + block + new[mn.end():]


def update(source=None):
    """Install the newest release (or the zip at `source`, a path or URL)."""
    if local_stamp().startswith('$Format'):
        print('This folder is a git working copy (no release version stamped in): update it with git pull.')
        return 1
    base = update_url()
    local = local_version()
    print('Widget files here: %s' % (local or 'unknown version'))
    if source:
        print('Reading %s ...' % source)
        try:
            if re.match(r'^https?://', source, re.I):
                data = fetch(source)
            else:
                with open(source, 'rb') as f:
                    data = f.read()
        except Exception as e:
            print('Could not read it (%s). Nothing changed.' % explain(e))
            return 1
    else:
        print('Checking %s ...' % base)
        try:
            latest = json.loads(fetch(base + 'version.json?_=%d' % int(time.time())).decode('utf-8'))['version']
        except Exception as e:                   # network, JSON, or a missing key
            print('Could not read the latest version (%s). Check the connection and try again.' % explain(e))
            return 1
        ln, rn = version_number(local), version_number(latest)
        if rn is None:
            print('Unexpected version "%s" from %s. Nothing changed.' % (latest, base))
            return 1
        if ln is not None and ln >= rn:
            print('Already current: the latest release is %s.' % latest)
            return 0
        print('Downloading %s ...' % latest)
        try:
            data = fetch(base + 'Widget.zip')
        except Exception as e:
            print('Download failed (%s). Nothing changed.' % explain(e))
            return 1

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        names = [n for n in zf.namelist() if not n.endswith('/')]
        remote = stamp_of(zf.read('now-playing-source.js').decode('utf-8', 'replace')) if 'now-playing-source.js' in names else ''
    except zipfile.BadZipFile:
        print('That is not a zip file. Nothing changed.')
        return 1
    if version_number(remote) is None:           # the zip's own stamp is what counts, not version.json
        print('That is not a release of the widget (no version stamped into now-playing-source.js). Nothing changed.')
        return 1
    if version_number(local) is not None and version_number(local) >= version_number(remote):
        print('Already current: that is %s.' % remote)
        return 0

    backup = os.path.join(ROOT, 'backup', local or time.strftime('%Y%m%d-%H%M%S'))
    replaced, kept = 0, 0
    for name in names:
        parts = name.split('/')
        if name in KEEP or '..' in parts or '' in parts:
            continue
        dest = os.path.join(ROOT, *parts)
        data = zf.read(name)
        if os.path.exists(dest):
            with open(dest, 'rb') as f:
                old = f.read()
            if old == data:
                continue
            os.makedirs(os.path.join(backup, *parts[:-1]), exist_ok=True)
            shutil.copy2(dest, os.path.join(backup, *parts))
            if name.endswith('-now-playing.html'):
                new_text = data.decode('utf-8', 'replace')
                merged = merge_root(old.decode('utf-8', 'replace'), new_text)
                if merged != new_text:
                    kept += 1
                data = merged.encode('utf-8')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(data)
        replaced += 1

    # Releases before the tools/ folder kept these at the top level: tidy them
    # into the backup rather than leaving two copies around.
    tidied = 0
    if ROOT != HERE:
        for name in STALE:
            old = os.path.join(ROOT, name)
            if name not in names and os.path.exists(old):
                os.makedirs(backup, exist_ok=True)
                shutil.move(old, os.path.join(backup, name))
                tidied += 1

    print('Updated %s -> %s: %d file(s) replaced%s.' % (
        local or 'unknown', remote, replaced,
        ', your colour settings kept in %d widget file(s)' % kept if kept else ''))
    if tidied:
        print('Moved %d old file(s) from before the tools folder into the backup.' % tidied)
    if replaced or tidied:
        print('The previous files are in %s' % backup)
    print('settings.txt was not touched. OBS shows the new version when the widget next loads.')
    return 0


# ── setup server ───────────────────────────────────────────────────────────

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):        # keep the terminal quiet
        pass

    def reply(self, status, ctype, body):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/callback', '/spotify-setup.html'):
            # The setup page, with a marker that tells it a helper is running.
            with open(PAGE, 'r', encoding='utf-8') as f:
                html = f.read()
            marker = json.dumps({'token': TOKEN, 'port': PORT, 'version': local_version(), 'updateUrl': update_url()})
            inject = '<script>window.SETUP_HELPER = %s;</script>\n</head>' % marker
            self.reply(200, 'text/html; charset=utf-8', html.replace('</head>', inject, 1).encode('utf-8'))
        elif path == '/settings':
            if os.path.exists(SETTINGS):
                with open(SETTINGS, 'rb') as f:
                    self.reply(200, 'text/plain; charset=utf-8', f.read())
            else:
                self.reply(404, 'text/plain; charset=utf-8', b'no settings.txt yet')
        else:
            self.reply(404, 'text/plain; charset=utf-8', b'not found')

    def do_POST(self):
        global SAVED
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length)
        if path != '/save':
            self.reply(404, 'text/plain; charset=utf-8', b'not found')
        elif self.headers.get('X-Setup-Token') != TOKEN:
            self.reply(403, 'text/plain; charset=utf-8', b'bad token')
        elif not body.strip():
            self.reply(400, 'text/plain; charset=utf-8', b'empty settings')
        else:
            with open(SETTINGS, 'wb') as f:      # UTF-8 exactly as the page sent it
                f.write(body)
            SAVED = True
            print('settings.txt saved in', ROOT, flush=True)
            self.reply(200, 'text/plain; charset=utf-8', b'saved')


def main():
    global PORT
    ap = argparse.ArgumentParser(description='Local helper for the Spotify widget: setup page server, or --update.')
    ap.add_argument('--port', type=int, default=8888)
    ap.add_argument('--timeout', type=int, default=20, help='minutes to keep running')
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--update', action='store_true', help='download the newest release into this folder and exit')
    ap.add_argument('--source', metavar='ZIP', help='with --update: install this zip (path or URL) instead of the newest release')
    args = ap.parse_args()
    PORT = args.port

    if not os.path.exists(PAGE):
        print('spotify-setup.html was not found next to this script. Keep the unzipped folder as it is (tools/ next to the widget files).')
        return 1
    if args.update or args.source:
        return update(args.source)

    server_class = getattr(http.server, 'ThreadingHTTPServer', http.server.HTTPServer)
    try:
        server = server_class(('127.0.0.1', PORT), Handler)
    except OSError:
        print('Port %d is already in use (often by Jupyter or another copy of this setup).' % PORT)
        print('Close that program and run this again, or open tools/spotify-setup.html directly in Chrome/Chromium.')
        return 1

    print()
    print('Spotify widget setup is running at http://127.0.0.1:%d/' % PORT)
    print('Finish the steps in your browser. Leave this running until the page says it saved settings.txt.')
    print('Press Ctrl+C to stop.')
    print()
    if not args.no_browser:
        webbrowser.open('http://127.0.0.1:%d/' % PORT)

    server.timeout = 0.5
    deadline = time.time() + args.timeout * 60
    try:
        while time.time() < deadline:
            server.handle_request()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    if SAVED:
        print('Done. settings.txt is saved.')
    else:
        print('Stopped without saving. Run it again when you are ready.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
