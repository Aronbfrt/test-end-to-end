#!/usr/bin/env python3
"""Optional live server — serves tests/report.html AND makes its "Relancer" button actually
re-run the single test via a local /__rerun__ endpoint, instead of just copying the command.

A plain `file://tests/report.html` has no backend to talk to — a browser can't execute
pytest by itself. This is the difference: open the report through this server instead of
double-clicking the file, and the button does the real thing.

Usage:
    python3 tests/live_server.py            # http://localhost:8765/tests/report.html
    python3 tests/live_server.py 9000        # custom port
"""
import http.server
import json
import socketserver
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if '/__rerun__' in (self.path or ''):
            super().log_message(fmt, *args)
        # stay quiet for static asset requests — keeps the terminal readable

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path != '/__rerun__':
            self._send_json(404, {'error': 'not found'})
            return
        length = int(self.headers.get('Content-Length', 0) or 0)
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            data = {}
        test_id = data.get('testId', '')
        if not test_id:
            self._send_json(400, {'error': 'testId manquant'})
            return
        print(f'[live] relance : {test_id}')
        try:
            result = subprocess.run(
                [sys.executable, '-m', 'pytest', test_id, '-v', '--tb=short', '-p', 'no:cacheprovider'],
                cwd=str(ROOT), capture_output=True, text=True, timeout=120,
            )
            self._send_json(200, {
                'passed': result.returncode == 0,
                'output': (result.stdout + result.stderr)[-4000:],
            })
        except subprocess.TimeoutExpired:
            self._send_json(200, {'passed': False, 'output': 'Timeout après 120s.'})
        except Exception as e:
            self._send_json(500, {'error': str(e)})


def main():
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
        print(f'[live] Rapport : http://localhost:{PORT}/tests/report.html')
        print('[live] Le bouton "Relancer" exécute vraiment le test depuis ce serveur. Ctrl+C pour arrêter.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n[live] arrêté.')


if __name__ == '__main__':
    main()
