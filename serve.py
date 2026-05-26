from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


APP_ROOT = Path(__file__).resolve().parent
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
PORT_ENV_NAMES = ("CHESS_TRAINER_PORT", "PORT")
HOST_ENV_NAMES = ("CHESS_TRAINER_HOST", "HOST")
DATA_DIR_ENV_NAME = "CHESS_TRAINER_DATA_DIR"
CORS_ORIGINS_ENV_NAME = "CHESS_TRAINER_CORS_ORIGINS"
STATIC_ASSET_CACHE_CONTROL = "public, max-age=300, must-revalidate"
IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
NO_STORE_CACHE_CONTROL = "no-store"
ALLOWED_IMPORT_HOSTS = {
    "chess.com",
    "www.chess.com",
    "m.chess.com",
    "api.chess.com",
}
MAX_IMPORT_BYTES = 2_000_000
MAX_IMPORT_RECORD_BYTES = 1_000_000
MAX_IMPORT_TEXT_BYTES = 900_000
MAX_IMPORT_FIELD_BYTES = 2_000
MAX_IMPORT_HEADER_COUNT = 32
MAX_IMPORT_MOVE_COUNT = 600
MAX_IMPORT_MOVE_CANDIDATES = 12
REQUEST_TIMEOUT_SECONDS = 15
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) ChessTrainer/1.0"
ACCEPT_HEADER = "text/html,text/plain,application/json;q=0.9,*/*;q=0.8"
IMPORT_PAGE_RATE_LIMIT = 30
IMPORT_PAGE_RATE_WINDOW_SECONDS = 5 * 60
IMPORT_RECORD_RATE_LIMIT = 60
IMPORT_RECORD_RATE_WINDOW_SECONDS = 5 * 60
IMPORT_RECORD_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
SOURCE_NAME_PATTERN = re.compile(r"^[a-z0-9_-]{1,32}$")
HEADER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,32}$")
IMPORT_RECORD_CACHE_DIR = Path(".chess-trainer-cache") / "import-records"
IMPORT_RECORD_TTL_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class ImportPage:
    text: str
    content_type: str
    final_url: str


class ImportRequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class SlidingWindowRateLimiter:
    def __init__(self, limit: int, window_seconds: int) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._events: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        current = time.time() if now is None else now
        threshold = current - self.window_seconds
        with self._lock:
            history = self._events.setdefault(key, deque())
            while history and history[0] <= threshold:
                history.popleft()
            if len(history) >= self.limit:
                return False
            history.append(current)
            if not history:
                self._events.pop(key, None)
            return True


IMPORT_PAGE_LIMITER = SlidingWindowRateLimiter(IMPORT_PAGE_RATE_LIMIT, IMPORT_PAGE_RATE_WINDOW_SECONDS)
IMPORT_RECORD_LIMITER = SlidingWindowRateLimiter(IMPORT_RECORD_RATE_LIMIT, IMPORT_RECORD_RATE_WINDOW_SECONDS)


def is_allowed_import_host(host: str) -> bool:
    normalized = host.lower()
    return any(normalized == allowed or normalized.endswith(f".{allowed}") for allowed in ALLOWED_IMPORT_HOSTS)


def validate_import_url(url: str) -> str:
    normalized_url = url.strip()
    if not normalized_url:
        raise ImportRequestError(400, "Missing url query parameter.")

    parsed = urlparse(normalized_url)
    if parsed.scheme not in {"http", "https"}:
        raise ImportRequestError(400, "Only http and https links are supported.")

    host = (parsed.hostname or "").lower()
    if not is_allowed_import_host(host):
        raise ImportRequestError(400, "Only Chess.com links are allowed for direct import.")

    return normalized_url


def import_url_from_query(query: str) -> str:
    return validate_import_url(parse_qs(query).get("url", [""])[0])


def build_import_request(url: str) -> Request:
    return Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": ACCEPT_HEADER,
        },
    )


def fetch_import_page(url: str, opener=urlopen) -> ImportPage:
    request = build_import_request(url)
    try:
        with opener(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            payload = response.read(MAX_IMPORT_BYTES + 1)
            if len(payload) > MAX_IMPORT_BYTES:
                raise ImportRequestError(413, "Imported page is too large.")

            charset = response.headers.get_content_charset() or "utf-8"
            return ImportPage(
                text=payload.decode(charset, errors="replace"),
                content_type=response.headers.get_content_type(),
                final_url=response.geturl(),
            )
    except ImportRequestError:
        raise
    except HTTPError as error:
        raise ImportRequestError(error.code, f"Chess.com returned HTTP {error.code}.") from error
    except URLError as error:
        reason = getattr(error, "reason", error)
        raise ImportRequestError(502, f"Could not reach Chess.com: {reason}.") from error
    except TimeoutError as error:
        raise ImportRequestError(504, "Timed out while fetching the Chess.com page.") from error


def should_serve_app_shell(path: str) -> bool:
    normalized = path.rstrip("/") or "/"
    return bool(
        re.fullmatch(r"/game/[^/]+/[^/]+", normalized)
        or re.fullmatch(r"/import/[A-Za-z0-9_-]{8,64}", normalized)
    )


def is_health_path(path: str) -> bool:
    normalized = path.rstrip("/") or "/"
    return normalized in {"/healthz", "/api/healthz"}


def runtime_host(default: str = DEFAULT_HOST, environ: dict[str, str] | None = None) -> str:
    source = os.environ if environ is None else environ
    for key in HOST_ENV_NAMES:
        value = source.get(key)
        if value and value.strip():
            return value.strip()
    return default


def runtime_port(default: int = DEFAULT_PORT, environ: dict[str, str] | None = None) -> int:
    source = os.environ if environ is None else environ
    for key in PORT_ENV_NAMES:
        value = source.get(key)
        if not value or not value.strip():
            continue
        try:
            port = int(value.strip())
        except ValueError as error:
            raise ValueError(f"{key} must be an integer.") from error
        if port <= 0 or port > 65535:
            raise ValueError(f"{key} must be between 1 and 65535.")
        return port
    return default


def runtime_data_root(base_dir: Path | None = None, environ: dict[str, str] | None = None) -> Path:
    if base_dir is not None:
        return Path(base_dir)

    source = os.environ if environ is None else environ
    configured = source.get(DATA_DIR_ENV_NAME)
    if configured and configured.strip():
        return Path(configured.strip()).expanduser()

    return APP_ROOT


def configured_cors_origins(environ: dict[str, str] | None = None) -> set[str]:
    source = os.environ if environ is None else environ
    raw = source.get(CORS_ORIGINS_ENV_NAME, "")
    return {
        item.strip().rstrip("/")
        for item in raw.split(",")
        if item.strip()
    }


def resolve_cors_origin(request_origin: str | None, environ: dict[str, str] | None = None) -> str | None:
    if not request_origin:
        return None

    normalized = request_origin.strip().rstrip("/")
    if not normalized:
        return None

    if normalized.startswith("chrome-extension://"):
        return normalized

    if normalized in {
        "http://127.0.0.1",
        "http://127.0.0.1:8000",
        "http://localhost",
        "http://localhost:8000",
    }:
        return normalized

    if normalized in configured_cors_origins(environ):
        return normalized

    return None


def content_security_policy_for_path(path: str) -> str | None:
    normalized = path.rstrip("/") or "/"
    if normalized not in {"/", "/index.html"} and not should_serve_app_shell(normalized):
        return None

    directives = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data: https://www.chess.com",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "worker-src 'self'",
        "font-src 'self'",
    ]
    return "; ".join(directives)


def cache_control_for_path(path: str) -> str:
    normalized = path.rstrip("/") or "/"
    if (
        normalized == "/"
        or normalized == "/index.html"
        or normalized.startswith("/api/")
        or should_serve_app_shell(normalized)
        or is_health_path(normalized)
    ):
        return NO_STORE_CACHE_CONTROL

    if normalized.startswith("/vendor/stockfish/"):
        return IMMUTABLE_ASSET_CACHE_CONTROL

    if re.search(r"\.(?:js|css|svg|wasm)$", normalized):
        return STATIC_ASSET_CACHE_CONTROL

    return NO_STORE_CACHE_CONTROL


def import_record_cache_dir(base_dir: Path | None = None) -> Path:
    root = runtime_data_root(base_dir)
    return root / IMPORT_RECORD_CACHE_DIR


def ensure_import_record_cache_dir(base_dir: Path | None = None) -> Path:
    cache_dir = import_record_cache_dir(base_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def validate_import_record_token(token: str) -> str:
    normalized = token.strip()
    if not IMPORT_RECORD_TOKEN_PATTERN.fullmatch(normalized):
        raise ImportRequestError(400, "Import record token is invalid.")
    return normalized


def import_record_path(token: str, base_dir: Path | None = None) -> Path:
    validated = validate_import_record_token(token)
    return ensure_import_record_cache_dir(base_dir) / f"{validated}.json"


def cleanup_stale_import_records(base_dir: Path | None = None, now: float | None = None) -> int:
    cache_dir = ensure_import_record_cache_dir(base_dir)
    threshold = (time.time() if now is None else now) - IMPORT_RECORD_TTL_SECONDS
    removed = 0

    for path in cache_dir.glob("*.json"):
        try:
            if path.stat().st_mtime < threshold:
                path.unlink()
                removed += 1
        except FileNotFoundError:
            continue

    return removed


def normalize_optional_text(
    value: object,
    *,
    field_name: str,
    max_bytes: int = MAX_IMPORT_FIELD_BYTES,
    allow_empty: bool = False,
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ImportRequestError(400, f"{field_name} must be a string.")

    normalized = value if allow_empty else value.strip()
    if not normalized:
        return "" if allow_empty else None

    if len(normalized.encode("utf-8")) > max_bytes:
        raise ImportRequestError(413, f"{field_name} is too large.")

    return normalized


def normalize_headers_object(payload: object) -> dict[str, str]:
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ImportRequestError(400, "headers must be a JSON object.")
    if len(payload) > MAX_IMPORT_HEADER_COUNT:
        raise ImportRequestError(413, "headers contains too many values.")

    normalized: dict[str, str] = {}
    for key, value in payload.items():
        if not isinstance(key, str) or not HEADER_NAME_PATTERN.fullmatch(key):
            raise ImportRequestError(400, "headers contains an invalid key.")
        text = normalize_optional_text(value, field_name=f"headers.{key}")
        if text:
            normalized[key] = text
    return normalized


def normalize_move_list(payload: object) -> list[str]:
    if payload is None:
        return []
    if not isinstance(payload, list):
        raise ImportRequestError(400, "moves must be an array of SAN strings.")
    if len(payload) > MAX_IMPORT_MOVE_COUNT:
        raise ImportRequestError(413, "moves contains too many entries.")

    normalized: list[str] = []
    for index, value in enumerate(payload):
        move = normalize_optional_text(value, field_name=f"moves[{index}]")
        if move:
            normalized.append(move)
    return normalized


def normalize_move_candidates(payload: object) -> list[dict[str, object]]:
    if payload is None:
        return []
    if not isinstance(payload, list):
        raise ImportRequestError(400, "moveCandidates must be an array.")
    if len(payload) > MAX_IMPORT_MOVE_CANDIDATES:
        raise ImportRequestError(413, "moveCandidates contains too many entries.")

    normalized: list[dict[str, object]] = []
    for index, candidate in enumerate(payload):
        if not isinstance(candidate, dict):
            raise ImportRequestError(400, f"moveCandidates[{index}] must be an object.")
        source = normalize_optional_text(candidate.get("source"), field_name=f"moveCandidates[{index}].source")
        moves = normalize_move_list(candidate.get("moves"))
        if moves:
            normalized.append({
                "source": source,
                "moves": moves,
            })
    return normalized


def validate_import_record_payload(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ImportRequestError(400, "Import payload must be a JSON object.")

    source = normalize_optional_text(payload.get("source"), field_name="source") or "manual"
    if not SOURCE_NAME_PATTERN.fullmatch(source):
        raise ImportRequestError(400, "source must use lowercase letters, numbers, dashes, or underscores.")

    source_url = normalize_optional_text(payload.get("sourceUrl"), field_name="sourceUrl")
    if source_url and source == "chesscom":
        source_url = validate_import_url(source_url)

    source_game_id = normalize_optional_text(payload.get("sourceGameId"), field_name="sourceGameId")
    pgn = normalize_optional_text(payload.get("pgn"), field_name="pgn", max_bytes=MAX_IMPORT_TEXT_BYTES, allow_empty=True)
    imported_text = normalize_optional_text(
        payload.get("importedText"),
        field_name="importedText",
        max_bytes=MAX_IMPORT_TEXT_BYTES,
        allow_empty=True,
    )
    headers = normalize_headers_object(payload.get("headers"))
    moves = normalize_move_list(payload.get("moves"))
    move_candidates = normalize_move_candidates(payload.get("moveCandidates"))

    if not (pgn and pgn.strip()) and not (imported_text and imported_text.strip()) and not moves and not move_candidates:
        raise ImportRequestError(400, "Import payload must include pgn, importedText, SAN moves, or moveCandidates.")

    return {
        "source": source,
        "sourceGameId": source_game_id,
        "sourceUrl": source_url,
        "pgn": pgn,
        "importedText": imported_text,
        "headers": headers,
        "moves": moves,
        "moveCandidates": move_candidates,
        "pageTitle": normalize_optional_text(payload.get("pageTitle"), field_name="pageTitle"),
        "extraction": normalize_optional_text(payload.get("extraction"), field_name="extraction"),
        "viewerUsername": normalize_optional_text(payload.get("viewerUsername"), field_name="viewerUsername"),
        "capturedAt": normalize_optional_text(payload.get("capturedAt"), field_name="capturedAt"),
    }


def save_import_record(payload: dict[str, object], base_dir: Path | None = None) -> str:
    cleanup_stale_import_records(base_dir)
    token = secrets.token_urlsafe(12)
    path = import_record_path(token, base_dir)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return token


def load_import_record(token: str, base_dir: Path | None = None) -> dict[str, object]:
    path = import_record_path(token, base_dir)
    try:
        if path.stat().st_mtime < time.time() - IMPORT_RECORD_TTL_SECONDS:
            path.unlink(missing_ok=True)
            raise ImportRequestError(404, "Import record not found.")
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ImportRequestError(404, "Import record not found.") from error
    except json.JSONDecodeError as error:
        raise ImportRequestError(500, "Stored import record is corrupted.") from error


def parse_import_record_token(path: str) -> str | None:
    match = re.fullmatch(r"/api/import-record/([A-Za-z0-9_-]{8,64})/?", path)
    if not match:
        return None
    return match[1]


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs) -> None:
        super().__init__(*args, directory=str(APP_ROOT if directory is None else directory), **kwargs)

    def do_OPTIONS(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/import-record" or parse_import_record_token(parsed.path):
            origin = resolve_cors_origin(self.headers.get("Origin"))
            if self.headers.get("Origin") and origin is None:
                self.send_response(403)
                self.end_headers()
                return
            self.send_response(204)
            self.send_cors_headers(origin)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if is_health_path(parsed.path):
            self.send_json(200, {"ok": True, "service": "chess-trainer"})
            return
        if parsed.path == "/api/import-game":
            self.handle_import_game(parsed.query)
            return
        import_record_token = parse_import_record_token(parsed.path)
        if import_record_token:
            self.handle_get_import_record(import_record_token)
            return
        if should_serve_app_shell(parsed.path):
            self.path = "/index.html"
            super().do_GET()
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/import-record":
            self.handle_post_import_record()
            return
        self.send_error(405, "Method Not Allowed")

    def end_headers(self) -> None:
        parsed_path = urlparse(self.path).path
        self.send_header("Cache-Control", cache_control_for_path(parsed_path))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        csp = content_security_policy_for_path(parsed_path)
        if csp:
            self.send_header("Content-Security-Policy", csp)
        super().end_headers()

    def send_cors_headers(self, allowed_origin: str | None) -> None:
        if allowed_origin:
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def handle_import_game(self, query: str) -> None:
        client_ip = self.client_address[0] if self.client_address else "unknown"
        if not IMPORT_PAGE_LIMITER.allow(client_ip):
            self.send_json(
                429,
                {"ok": False, "error": "Import rate limit exceeded. Please wait a moment and try again."},
            )
            return

        try:
            import_url = import_url_from_query(query)
            page = fetch_import_page(import_url)
        except ImportRequestError as error:
            self.send_json(error.status, {"ok": False, "error": error.message})
            return

        self.send_json(
            200,
            {
                "ok": True,
                "text": page.text,
                "content_type": page.content_type,
                "final_url": page.final_url,
            },
        )

    def handle_post_import_record(self) -> None:
        request_origin = self.headers.get("Origin")
        if request_origin and resolve_cors_origin(request_origin) is None:
            self.send_json(403, {"ok": False, "error": "Origin is not allowed for import handoff."}, cors=False)
            return

        client_ip = self.client_address[0] if self.client_address else "unknown"
        if not IMPORT_RECORD_LIMITER.allow(client_ip):
            self.send_json(
                429,
                {"ok": False, "error": "Import handoff rate limit exceeded. Please wait a moment and try again."},
                cors=True,
            )
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"ok": False, "error": "Content-Length header is invalid."}, cors=True)
            return

        if content_length <= 0:
            self.send_json(400, {"ok": False, "error": "Import payload is missing."}, cors=True)
            return
        if content_length > MAX_IMPORT_RECORD_BYTES:
            self.send_json(413, {"ok": False, "error": "Import payload is too large."}, cors=True)
            return

        try:
            raw_body = self.rfile.read(content_length)
            payload = json.loads(raw_body.decode("utf-8"))
            validated = validate_import_record_payload(payload)
            token = save_import_record(validated)
        except ImportRequestError as error:
            self.send_json(error.status, {"ok": False, "error": error.message}, cors=True)
            return
        except json.JSONDecodeError:
            self.send_json(400, {"ok": False, "error": "Import payload must be valid JSON."}, cors=True)
            return

        self.send_json(
            200,
            {
                "ok": True,
                "token": token,
                "review_url": f"/import/{token}",
            },
            cors=True,
        )

    def handle_get_import_record(self, token: str) -> None:
        try:
            payload = load_import_record(token)
        except ImportRequestError as error:
            self.send_json(error.status, {"ok": False, "error": error.message}, cors=True)
            return

        self.send_json(
            200,
            {
                "ok": True,
                "token": token,
                "payload": payload,
            },
            cors=True,
        )

    def send_json(self, status: int, payload: dict[str, object], *, cors: bool = False) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cors:
            self.send_cors_headers(resolve_cors_origin(self.headers.get("Origin")))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def copyfile(self, source, outputfile) -> None:
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve Chess Trainer locally.")
    try:
        default_host = runtime_host()
        default_port = runtime_port()
    except ValueError as error:
        parser.error(str(error))
    parser.add_argument("--host", default=default_host, help=f"Host to bind to. Default: {default_host}")
    parser.add_argument("--port", type=int, default=default_port, help=f"Port to bind to. Default: {default_port}")
    return parser.parse_args(argv)


def run_server(host: str, port: int) -> None:
    server = ThreadingHTTPServer((host, port), NoCacheHandler)
    print(f"Serving Chess Trainer at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
