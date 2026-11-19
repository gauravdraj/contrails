"""Quiet static export host for the watch page; Python 3.9 stdlib only.

http.server plus gzip (tailscale serve does not compress), no-cache revalidation, no directory listings,
paths confined to the export root. Usage: python3 _watch/serve.py [--bind 127.0.0.1] PORT (run from the export root).
"""
import argparse, gzip, io, mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

mimetypes.add_type('application/manifest+json', '.webmanifest')
mimetypes.add_type('font/woff2', '.woff2')
ROOT = Path.cwd().resolve()
TEXT = {'.js', '.json', '.css', '.html', '.webmanifest', '.txt'}


def accepts_gzip(header):
    for token in header.split(','):
        parts = [p.strip().lower() for p in token.split(';')]
        if parts[0] not in ('gzip', '*'):
            continue
        q = 1.0
        for p in parts[1:]:
            if p.startswith('q='):
                try:
                    q = float(p[2:])
                except ValueError:
                    q = 0.0
        return q > 0
    return False


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_head(self):
        try:
            path = Path(self.translate_path(self.path)).resolve()
            path.relative_to(ROOT)  # symlinks may not escape the export
        except ValueError:
            self.send_error(400 if '\0' in self.path or '%00' in self.path else 404)
            return None
        if path.is_dir():
            if (path / 'index.html').is_file() and not self.path.split('?', 1)[0].endswith('/'):
                return super().send_head()  # redirect to the trailing-slash URL
            path = path / 'index.html'
        try:
            body = path.read_bytes()
        except (OSError, ValueError):
            self.send_error(404)
            return None
        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(str(path)))
        if path.suffix in TEXT:
            self.send_header('Vary', 'Accept-Encoding')
            if accepts_gzip(self.headers.get('Accept-Encoding', '')):
                body = gzip.compress(body)
                self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)


parser = argparse.ArgumentParser()
parser.add_argument('--bind', default='127.0.0.1')
parser.add_argument('port', type=int)
args = parser.parse_args()
server = ThreadingHTTPServer((args.bind, args.port), Handler)
print(server.server_port, flush=True)
server.serve_forever()
