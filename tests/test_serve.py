import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError

import serve


class FakeHeaders:
    def __init__(self, charset: str = "utf-8", content_type: str = "text/html") -> None:
        self._charset = charset
        self._content_type = content_type

    def get_content_charset(self) -> str:
        return self._charset

    def get_content_type(self) -> str:
        return self._content_type


class FakeResponse:
    def __init__(self, payload: bytes, final_url: str = "https://www.chess.com/game/live/123") -> None:
        self._payload = payload
        self._final_url = final_url
        self.headers = FakeHeaders()

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def read(self, _size: int) -> bytes:
        return self._payload

    def geturl(self) -> str:
        return self._final_url


class ServeTests(unittest.TestCase):
    def test_is_allowed_import_host_accepts_known_hosts_and_subdomains(self) -> None:
        self.assertTrue(serve.is_allowed_import_host("www.chess.com"))
        self.assertTrue(serve.is_allowed_import_host("analysis.chess.com"))
        self.assertFalse(serve.is_allowed_import_host("example.com"))
        self.assertFalse(serve.is_allowed_import_host("chess.com.evil.test"))

    def test_validate_import_url_rejects_missing_or_invalid_urls(self) -> None:
        with self.assertRaises(serve.ImportRequestError) as missing:
            serve.validate_import_url("")
        self.assertEqual(missing.exception.status, 400)

        with self.assertRaises(serve.ImportRequestError) as invalid_scheme:
            serve.validate_import_url("ftp://www.chess.com/game/live/123")
        self.assertEqual(invalid_scheme.exception.status, 400)

        with self.assertRaises(serve.ImportRequestError) as invalid_host:
            serve.validate_import_url("https://example.com/game/live/123")
        self.assertEqual(invalid_host.exception.status, 400)

    def test_import_url_from_query_extracts_and_validates_url(self) -> None:
        query = "url=https%3A%2F%2Fwww.chess.com%2Fgame%2Flive%2F123"
        self.assertEqual(
            serve.import_url_from_query(query),
            "https://www.chess.com/game/live/123",
        )

    def test_should_serve_app_shell_accepts_game_routes_only(self) -> None:
        self.assertTrue(serve.should_serve_app_shell("/game/chesscom/169208992842"))
        self.assertTrue(serve.should_serve_app_shell("/game/local/deadbeef"))
        self.assertTrue(serve.should_serve_app_shell("/import/abc12345"))
        self.assertFalse(serve.should_serve_app_shell("/import/styles.css"))
        self.assertFalse(serve.should_serve_app_shell("/import/app.js"))
        self.assertFalse(serve.should_serve_app_shell("/game/chesscom/169208992842/extra"))
        self.assertFalse(serve.should_serve_app_shell("/styles.css"))
        self.assertFalse(serve.should_serve_app_shell("/api/import-game"))

    def test_is_health_path_accepts_only_health_endpoints(self) -> None:
        self.assertTrue(serve.is_health_path("/healthz"))
        self.assertTrue(serve.is_health_path("/api/healthz"))
        self.assertFalse(serve.is_health_path("/"))
        self.assertFalse(serve.is_health_path("/health"))

    def test_runtime_host_and_port_read_environment_overrides(self) -> None:
        environ = {
            "CHESS_TRAINER_HOST": "0.0.0.0",
            "PORT": "9123",
        }
        self.assertEqual(serve.runtime_host(environ=environ), "0.0.0.0")
        self.assertEqual(serve.runtime_port(environ=environ), 9123)

    def test_runtime_port_rejects_invalid_environment_values(self) -> None:
        with self.assertRaises(ValueError):
            serve.runtime_port(environ={"PORT": "abc"})
        with self.assertRaises(ValueError):
            serve.runtime_port(environ={"PORT": "70000"})

    def test_runtime_data_root_prefers_explicit_base_dir_then_environment(self) -> None:
        with TemporaryDirectory() as temp_dir:
            explicit = Path(temp_dir) / "explicit"
            from_env = Path(temp_dir) / "env"
            self.assertEqual(serve.runtime_data_root(explicit, environ={serve.DATA_DIR_ENV_NAME: str(from_env)}), explicit)
            self.assertEqual(serve.runtime_data_root(None, environ={serve.DATA_DIR_ENV_NAME: str(from_env)}), from_env)
            self.assertEqual(serve.runtime_data_root(None, environ={}), serve.APP_ROOT)

    def test_cache_control_for_path_matches_route_types(self) -> None:
        self.assertEqual(serve.cache_control_for_path("/"), serve.NO_STORE_CACHE_CONTROL)
        self.assertEqual(serve.cache_control_for_path("/game/chesscom/123"), serve.NO_STORE_CACHE_CONTROL)
        self.assertEqual(serve.cache_control_for_path("/api/import-record/test"), serve.NO_STORE_CACHE_CONTROL)
        self.assertEqual(serve.cache_control_for_path("/vendor/stockfish/stockfish-18-lite-single.wasm"), serve.IMMUTABLE_ASSET_CACHE_CONTROL)
        self.assertEqual(serve.cache_control_for_path("/app.js"), serve.STATIC_ASSET_CACHE_CONTROL)

    def test_resolve_cors_origin_allows_extension_and_configured_origins(self) -> None:
        self.assertEqual(
            serve.resolve_cors_origin("chrome-extension://abc123"),
            "chrome-extension://abc123",
        )
        self.assertEqual(
            serve.resolve_cors_origin(
                "https://trainer.example.com",
                environ={serve.CORS_ORIGINS_ENV_NAME: "https://trainer.example.com, https://beta.example.com"},
            ),
            "https://trainer.example.com",
        )
        self.assertIsNone(serve.resolve_cors_origin("https://evil.example.com"))

    def test_content_security_policy_is_only_applied_to_html_shell_routes(self) -> None:
        csp = serve.content_security_policy_for_path("/game/chesscom/123")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("worker-src 'self'", csp)
        self.assertIsNone(serve.content_security_policy_for_path("/app.js"))

    def test_sliding_window_rate_limiter_enforces_limit_and_expires_old_events(self) -> None:
        limiter = serve.SlidingWindowRateLimiter(limit=2, window_seconds=10)
        self.assertTrue(limiter.allow("ip", now=100))
        self.assertTrue(limiter.allow("ip", now=105))
        self.assertFalse(limiter.allow("ip", now=109))
        self.assertTrue(limiter.allow("ip", now=111))

    def test_validate_import_record_payload_accepts_pgn_and_chesscom_metadata(self) -> None:
        payload = serve.validate_import_record_payload(
            {
                "source": "chesscom",
                "sourceGameId": "169208992842",
                "sourceUrl": "https://www.chess.com/game/live/169208992842",
                "pgn": "1. e4 e5 2. Nf3 Nc6 1-0",
                "pageTitle": "Alpha vs Beta",
                "viewerUsername": "Alpha",
            }
        )
        self.assertEqual(payload["source"], "chesscom")
        self.assertEqual(payload["sourceGameId"], "169208992842")
        self.assertEqual(payload["sourceUrl"], "https://www.chess.com/game/live/169208992842")
        self.assertEqual(payload["pgn"], "1. e4 e5 2. Nf3 Nc6 1-0")
        self.assertEqual(payload["viewerUsername"], "Alpha")

    def test_validate_import_record_payload_rejects_missing_text(self) -> None:
        with self.assertRaises(serve.ImportRequestError) as error:
            serve.validate_import_record_payload({"source": "manual"})
        self.assertEqual(error.exception.status, 400)

    def test_validate_import_record_payload_accepts_headers_and_san_moves(self) -> None:
        payload = serve.validate_import_record_payload(
            {
                "source": "chesscom",
                "sourceGameId": "169208992842",
                "sourceUrl": "https://www.chess.com/game/live/169208992842",
                "headers": {
                    "White": "Alpha",
                    "Black": "Beta",
                    "Result": "1-0",
                },
                "moves": ["e4", "e5", "Nf3", "Nc6"],
            }
        )
        self.assertEqual(payload["headers"]["White"], "Alpha")
        self.assertEqual(payload["moves"], ["e4", "e5", "Nf3", "Nc6"])

    def test_validate_import_record_payload_accepts_move_candidates(self) -> None:
        payload = serve.validate_import_record_payload(
            {
                "source": "chesscom",
                "sourceUrl": "https://www.chess.com/game/live/169214066654",
                "headers": {
                    "White": "Alpha",
                    "Black": "Beta",
                    "Result": "1-0",
                },
                "moveCandidates": [
                    {"source": "[class*=move-list] span", "moves": ["e4", "e5", "Nf3", "Nc6"]},
                    {"source": "document.body", "moves": ["e4", "c6", "f3", "d5"]},
                ],
            }
        )
        self.assertEqual(len(payload["moveCandidates"]), 2)
        self.assertEqual(payload["moveCandidates"][0]["moves"], ["e4", "e5", "Nf3", "Nc6"])

    def test_save_and_load_import_record_round_trip(self) -> None:
        with TemporaryDirectory() as temp_dir:
            base_dir = Path(temp_dir)
            payload = {
                "source": "chesscom",
                "sourceGameId": "169208992842",
                "sourceUrl": "https://www.chess.com/game/live/169208992842",
                "pgn": "1. e4 e5 2. Nf3 Nc6 1-0",
                "importedText": None,
                "headers": {},
                "moves": [],
                "moveCandidates": [],
                "pageTitle": "Alpha vs Beta",
                "extraction": "embedded-pgn",
                "capturedAt": "2026-05-25T14:00:00Z",
            }
            token = serve.save_import_record(payload, base_dir)
            loaded = serve.load_import_record(token, base_dir)

        self.assertEqual(loaded, payload)
        self.assertRegex(token, r"^[A-Za-z0-9_-]{8,64}$")

    def test_parse_import_record_token_extracts_api_token(self) -> None:
        self.assertEqual(serve.parse_import_record_token("/api/import-record/abc12345"), "abc12345")
        self.assertIsNone(serve.parse_import_record_token("/api/import-record"))

    def test_cleanup_stale_import_records_removes_expired_files(self) -> None:
        with TemporaryDirectory() as temp_dir:
            base_dir = Path(temp_dir)
            cache_dir = serve.ensure_import_record_cache_dir(base_dir)
            stale_path = cache_dir / "stale-token.json"
            fresh_path = cache_dir / "fresh-token.json"
            stale_path.write_text("{}", encoding="utf-8")
            fresh_path.write_text("{}", encoding="utf-8")
            old_time = 1_000_000
            fresh_time = old_time + serve.IMPORT_RECORD_TTL_SECONDS + 10
            stale_path.touch()
            fresh_path.touch()
            import os

            os.utime(stale_path, (old_time, old_time))
            os.utime(fresh_path, (fresh_time, fresh_time))

            removed = serve.cleanup_stale_import_records(base_dir, now=fresh_time)
            self.assertEqual(removed, 1)
            self.assertFalse(stale_path.exists())
            self.assertTrue(fresh_path.exists())

    def test_fetch_import_page_returns_decoded_content(self) -> None:
        page = serve.fetch_import_page(
            "https://www.chess.com/game/live/123",
            opener=lambda request, timeout: FakeResponse(b"hello world"),
        )
        self.assertEqual(page.text, "hello world")
        self.assertEqual(page.content_type, "text/html")
        self.assertEqual(page.final_url, "https://www.chess.com/game/live/123")

    def test_fetch_import_page_rejects_oversized_payloads(self) -> None:
        oversized = b"x" * (serve.MAX_IMPORT_BYTES + 1)
        with self.assertRaises(serve.ImportRequestError) as error:
            serve.fetch_import_page(
                "https://www.chess.com/game/live/123",
                opener=lambda request, timeout: FakeResponse(oversized),
            )
        self.assertEqual(error.exception.status, 413)

    def test_fetch_import_page_maps_network_errors(self) -> None:
        def raise_url_error(request, timeout):
            raise URLError("offline")

        with self.assertRaises(serve.ImportRequestError) as url_error:
            serve.fetch_import_page("https://www.chess.com/game/live/123", opener=raise_url_error)
        self.assertEqual(url_error.exception.status, 502)

        def raise_http_error(request, timeout):
            raise HTTPError(request.full_url, 403, "Forbidden", hdrs=None, fp=None)

        with self.assertRaises(serve.ImportRequestError) as http_error:
            serve.fetch_import_page("https://www.chess.com/game/live/123", opener=raise_http_error)
        self.assertEqual(http_error.exception.status, 403)


if __name__ == "__main__":
    unittest.main()
