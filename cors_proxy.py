#!/usr/bin/env python3
"""
CORS-прокси для локальной LLM.

Зачем нужен:
  Figma в браузере (а на Linux официального Desktop нет, поэтому она работает
  именно в браузере) блокирует HTTP-запросы из плагина к удалённым адресам
  типа 10.7.27.10:11436. Браузер делает исключение для localhost — поэтому
  достаточно поднять прокси на этой же машине.

Запуск (без зависимостей, нужен только Python 3):
    python3 cors_proxy.py

После запуска в плагине поменяйте API URL на:
    http://localhost:8080/v1/chat/completions

Можно поменять порт и адрес апстрима через переменные окружения:
    PROXY_PORT=9000 UPSTREAM=http://10.7.27.10:11436 python3 cors_proxy.py
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import os
import sys

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("PROXY_PORT", "8080"))
UPSTREAM    = os.environ.get("UPSTREAM", "http://10.7.27.10:11436").rstrip("/")


class CORSProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- CORS ----
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- Прокси-методы ----
    def do_GET(self):  self._proxy("GET")
    def do_POST(self): self._proxy("POST")
    def do_PUT(self):  self._proxy("PUT")
    def do_DELETE(self): self._proxy("DELETE")

    def _proxy(self, method):
        url = UPSTREAM + self.path

        body = None
        length = self.headers.get("Content-Length")
        if length and int(length) > 0:
            body = self.rfile.read(int(length))

        req = urllib.request.Request(url, data=body, method=method)
        for h, v in self.headers.items():
            if h.lower() in ("host", "content-length", "connection"):
                continue
            req.add_header(h, v)

        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self._send_cors_headers()
                content_type = resp.headers.get("Content-Type", "application/json")
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read() or b""
            self.send_response(e.code)
            self._send_cors_headers()
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            msg = ('{"error":"proxy: ' + str(e).replace('"', "'") + '"}').encode()
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, fmt, *args):
        sys.stderr.write("[proxy %s] %s - %s\n" %
                         (self.log_date_time_string(), self.address_string(), fmt % args))


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with ThreadedTCPServer((LISTEN_HOST, LISTEN_PORT), CORSProxyHandler) as httpd:
        print("=" * 60)
        print("CORS-прокси запущен")
        print("  Слушает:    http://%s:%d/" % (LISTEN_HOST, LISTEN_PORT))
        print("  Форвардит:  %s" % UPSTREAM)
        print()
        print("В плагине Figma укажите API URL:")
        print("  http://localhost:%d/v1/chat/completions" % LISTEN_PORT)
        print()
        print("Остановить: Ctrl+C")
        print("=" * 60)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nПрокси остановлен.")
