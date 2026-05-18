import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


ALLOWED_IMPORT_HOSTS = {
    "chess.com",
    "www.chess.com",
    "m.chess.com",
    "api.chess.com",
}
MAX_IMPORT_BYTES = 2_000_000


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/import-game":
            self.handle_import_game(parsed.query)
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_import_game(self, query: str) -> None:
        url = parse_qs(query).get("url", [""])[0].strip()
        if not url:
            self.send_json(400, {"ok": False, "error": "Missing url query parameter."})
            return

        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            self.send_json(400, {"ok": False, "error": "Only http and https links are supported."})
            return

        host = (parsed.hostname or "").lower()
        if not self.is_allowed_import_host(host):
            self.send_json(400, {"ok": False, "error": "Only Chess.com links are allowed for direct import."})
            return

        request = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ChessTrainer/1.0",
                "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
            },
        )

        try:
            with urlopen(request, timeout=15) as response:
                payload = response.read(MAX_IMPORT_BYTES + 1)
                if len(payload) > MAX_IMPORT_BYTES:
                    self.send_json(413, {"ok": False, "error": "Imported page is too large."})
                    return

                charset = response.headers.get_content_charset() or "utf-8"
                text = payload.decode(charset, errors="replace")
                self.send_json(
                    200,
                    {
                        "ok": True,
                        "text": text,
                        "content_type": response.headers.get_content_type(),
                        "final_url": response.geturl(),
                    },
                )
        except HTTPError as error:
            self.send_json(error.code, {"ok": False, "error": f"Chess.com returned HTTP {error.code}."})
        except URLError as error:
            reason = getattr(error, "reason", error)
            self.send_json(502, {"ok": False, "error": f"Could not reach Chess.com: {reason}."})
        except TimeoutError:
            self.send_json(504, {"ok": False, "error": "Timed out while fetching the Chess.com page."})

    def is_allowed_import_host(self, host: str) -> bool:
        return any(host == allowed or host.endswith(f".{allowed}") for allowed in ALLOWED_IMPORT_HOSTS)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8000), NoCacheHandler)
    print("Serving Chess Trainer at http://127.0.0.1:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
