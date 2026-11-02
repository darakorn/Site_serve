#!/usr/bin/env python3
"""Serve the site-survey app and accept project uploads into a DATA folder.

    python3 server.py [--port 8080] [--bind 127.0.0.1] [--data DATA]

Static files come from this folder. The app uploads one file per request:

    GET  api/ping                      -> {"ok": true}
    PUT  api/upload?path=<date>/<project>/<file>   (raw file body)

Files land in DATA/<date>/<project>/..., overwriting what is there. There is no login:
keep the server on a private network (bind to localhost behind `tailscale serve`, or the
office LAN).
"""

import argparse
import json
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

APP_DIR = Path(__file__).resolve().parent
MAX_BYTES = 200 * 1024 * 1024
# Path segments may hold Thai and most punctuation, but nothing that steps out of DATA.
BAD = re.compile(r'[\x00-\x1f\\/:*?"<>|]')


def safe_parts(path):
    parts = [p.strip() for p in path.split('/')]
    if not parts or any(not p or p in ('.', '..') or p.startswith('.') or BAD.search(p) for p in parts):
        return None
    return parts


class Handler(SimpleHTTPRequestHandler):
    data_dir: Path

    def send_json(self, code, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def api(self):
        url = urlsplit(self.path)
        return url.path.rsplit('/api/', 1)[-1] if '/api/' in url.path else None, parse_qs(url.query)

    def do_GET(self):
        name, _ = self.api()
        if name == 'ping':
            return self.send_json(200, {'ok': True})
        # Never hand out uploads, the server itself or dotfiles as static files.
        first = urlsplit(self.path).path.lstrip('/').split('/', 1)[0]
        if first in (self.data_dir.name, 'server.py') or first.startswith('.'):
            return self.send_error(404)
        return super().do_GET()

    def do_PUT(self):
        name, query = self.api()
        if name != 'upload':
            return self.send_error(404)
        parts = safe_parts(query.get('path', [''])[0])
        if not parts or len(parts) < 2:
            return self.send_json(400, {'ok': False, 'error': 'bad path'})
        size = int(self.headers.get('Content-Length') or 0)
        if size > MAX_BYTES:
            return self.send_json(413, {'ok': False, 'error': 'file too large'})
        target = self.data_dir.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + '.part')
        with open(tmp, 'wb') as f:
            left = size
            while left:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left:
            tmp.unlink(missing_ok=True)
            return self.send_json(400, {'ok': False, 'error': 'incomplete upload'})
        tmp.replace(target)
        return self.send_json(200, {'ok': True, 'path': '/'.join(parts)})

    do_POST = do_PUT


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--bind', default='127.0.0.1')
    ap.add_argument('--data', default=str(APP_DIR / 'DATA'), help='folder for uploads (default: ./DATA)')
    args = ap.parse_args()
    data = Path(args.data).resolve()
    data.mkdir(parents=True, exist_ok=True)
    Handler.data_dir = data
    server = ThreadingHTTPServer((args.bind, args.port), partial(Handler, directory=str(APP_DIR)))
    print(f'Serving {APP_DIR} on http://{args.bind}:{args.port}/  uploads -> {data}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
