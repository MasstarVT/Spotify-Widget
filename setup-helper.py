#!/usr/bin/env python3
"""setup-helper.py - local helper for spotify-setup.html (Linux / macOS).

Started by setup-spotify.sh. Runs a tiny web server on 127.0.0.1:8888 that
serves spotify-setup.html from this folder, receives Spotify's redirect, and
writes settings.txt right here, so the setup finishes without copying URLs
or picking folders.

It only listens on this computer (127.0.0.1), only serves the setup page,
and only writes settings.txt. Press Ctrl+C or close the terminal to stop it.
"""
import argparse
import http.server
import os
import secrets
import sys
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(ROOT, 'spotify-setup.html')
SETTINGS = os.path.join(ROOT, 'settings.txt')
TOKEN = secrets.token_hex(16)
PORT = 8888
SAVED = False


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
            inject = "<script>window.SETUP_HELPER = { token: '%s', port: %d };</script>\n</head>" % (TOKEN, PORT)
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
    ap = argparse.ArgumentParser(description='Local helper for the Spotify widget setup page.')
    ap.add_argument('--port', type=int, default=8888)
    ap.add_argument('--timeout', type=int, default=20, help='minutes to keep running')
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()
    PORT = args.port

    if not os.path.exists(PAGE):
        print('spotify-setup.html was not found next to this script. Keep the widget files together in one folder.')
        return 1

    server_class = getattr(http.server, 'ThreadingHTTPServer', http.server.HTTPServer)
    try:
        server = server_class(('127.0.0.1', PORT), Handler)
    except OSError:
        print('Port %d is already in use (often by Jupyter or another copy of this setup).' % PORT)
        print('Close that program and run this again, or open spotify-setup.html directly in Chrome/Chromium.')
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
