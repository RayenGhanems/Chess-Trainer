import test from "node:test";
import assert from "node:assert/strict";

import { parseImportedGame } from "../src/domain/chess.js";
import {
  buildImportTokenRoute,
  buildNormalizedGameRecord,
  buildPgnFromSanMoves,
  extractChessComGameRef,
  parseImportTokenRoute,
  parseGameRoute,
  routePathForRecord,
} from "../src/domain/import.js";

const SAMPLE_PGN = `
[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.05.25"]
[White "Alpha"]
[Black "Beta"]
[Result "1-0"]
[TimeControl "600"]
[Link "https://www.chess.com/game/live/169208992842"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
`;

test("extractChessComGameRef handles live and analysis paths", () => {
  assert.deepEqual(
    extractChessComGameRef("https://www.chess.com/game/169214066654"),
    {
      source: "chesscom",
      sourceGameId: "169214066654",
      sourceUrl: "https://www.chess.com/game/169214066654",
    },
  );
  assert.deepEqual(
    extractChessComGameRef("https://www.chess.com/game/live/169208992842"),
    {
      source: "chesscom",
      sourceGameId: "169208992842",
      sourceUrl: "https://www.chess.com/game/live/169208992842",
    },
  );
  assert.deepEqual(
    extractChessComGameRef("https://www.chess.com/analysis/game/live/169208992842?tab=analysis"),
    {
      source: "chesscom",
      sourceGameId: "169208992842",
      sourceUrl: "https://www.chess.com/analysis/game/live/169208992842?tab=analysis",
    },
  );
  assert.equal(extractChessComGameRef("https://example.com/game/live/169208992842"), null);
});

test("buildNormalizedGameRecord derives a cached permalink from PGN headers", () => {
  const parsed = parseImportedGame(SAMPLE_PGN);
  const record = buildNormalizedGameRecord(parsed);

  assert.equal(record.source, "chesscom");
  assert.equal(record.sourceGameId, "169208992842");
  assert.equal(record.sourceUrl, "https://www.chess.com/game/live/169208992842");
  assert.equal(record.whiteUsername, "Alpha");
  assert.equal(record.blackUsername, "Beta");
  assert.equal(record.result, "1-0");
  assert.equal(record.timeControl, "600");
  assert.equal(record.playedAt, "2026-05-25");
  assert.equal(record.moveCount, 6);
  assert.match(record.pgnHash, /^[0-9a-f]{16}$/);
  assert.equal(routePathForRecord(record), "/game/chesscom/169208992842");
  assert.equal(record.headers.Link, "https://www.chess.com/game/live/169208992842");
  assert.ok(record.pgn.includes("[Link \"https://www.chess.com/game/live/169208992842\"]"));
});

test("buildNormalizedGameRecord derives viewer color from the clicking username", () => {
  const parsed = parseImportedGame(SAMPLE_PGN);
  const record = buildNormalizedGameRecord(parsed, {
    viewerUsername: "beta",
  });

  assert.equal(record.viewerUsername, "beta");
  assert.equal(record.viewerColor, "b");
});

test("manual imports fall back to a local hash route", () => {
  const parsed = parseImportedGame("1. e4 e5 2. Nf3 Nc6 *");
  const record = buildNormalizedGameRecord(parsed);

  assert.equal(record.source, "manual");
  assert.equal(record.sourceGameId, null);
  assert.equal(record.sourceUrl, null);
  assert.equal(routePathForRecord(record), `/game/local/${record.pgnHash}`);
  assert.deepEqual(parseGameRoute(routePathForRecord(record)), { pgnHash: record.pgnHash });
});

test("parseGameRoute decodes source routes", () => {
  assert.deepEqual(parseGameRoute("/game/chesscom/169208992842"), {
    source: "chesscom",
    sourceGameId: "169208992842",
  });
  assert.equal(parseGameRoute("/"), null);
});

test("import token routes round-trip cleanly", () => {
  assert.equal(buildImportTokenRoute("abc12345"), "/import/abc12345");
  assert.deepEqual(parseImportTokenRoute("/import/abc12345"), { token: "abc12345" });
  assert.equal(parseImportTokenRoute("/game/chesscom/169208992842"), null);
});

test("buildPgnFromSanMoves synthesizes a valid PGN from headers and SAN moves", () => {
  const pgn = buildPgnFromSanMoves(
    {
      Event: "Live Chess",
      Site: "Chess.com",
      White: "Alpha",
      Black: "Beta",
      Result: "1-0",
    },
    ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"],
  );

  const parsed = parseImportedGame(pgn);
  assert.equal(parsed.headers.White, "Alpha");
  assert.equal(parsed.headers.Black, "Beta");
  assert.equal(parsed.headers.Result, "1-0");
  assert.equal(parsed.moves.length, 6);
});
