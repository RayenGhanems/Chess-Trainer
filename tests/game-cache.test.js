import test from "node:test";
import assert from "node:assert/strict";

import { createGameCache } from "../src/adapters/storage/gameCache.js";

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

test("game cache deduplicates by PGN hash and upgrades source lookup", () => {
  const cache = createGameCache(createMemoryStorage());
  const manualRecord = cache.save({
    source: "manual",
    sourceGameId: null,
    sourceUrl: null,
    whiteUsername: "Alpha",
    blackUsername: "Beta",
    result: "1-0",
    variant: null,
    timeControl: "600",
    playedAt: "2026-05-25",
    pgn: "1. e4 e5 2. Nf3 Nc6 1-0",
    pgnHash: "deadbeef00000001",
    finalFen: "fen-a",
    moveCount: 4,
    headers: { White: "Alpha", Black: "Beta", Result: "1-0" },
    createdAt: "2026-05-25T10:00:00.000Z",
  });

  const upgradedRecord = cache.save({
    ...manualRecord,
    source: "chesscom",
    sourceGameId: "169208992842",
    sourceUrl: "https://www.chess.com/game/live/169208992842",
    viewerUsername: "Beta",
    viewerColor: "b",
    headers: {
      ...manualRecord.headers,
      Link: "https://www.chess.com/game/live/169208992842",
    },
  });

  assert.equal(cache.listRecentGames().length, 1);
  assert.equal(cache.findByPgnHash("deadbeef00000001")?.sourceGameId, "169208992842");
  assert.equal(
    cache.findBySourceGameId("chesscom", "169208992842")?.sourceUrl,
    "https://www.chess.com/game/live/169208992842",
  );
  assert.equal(cache.findByPgnHash("deadbeef00000001")?.viewerColor, "b");
  assert.equal(upgradedRecord.headers.Link, "https://www.chess.com/game/live/169208992842");
});

test("game cache keeps most recently opened records first", () => {
  const cache = createGameCache(createMemoryStorage());
  cache.save({
    source: "manual",
    sourceGameId: null,
    sourceUrl: null,
    whiteUsername: "First",
    blackUsername: "Game",
    result: "*",
    variant: null,
    timeControl: null,
    playedAt: null,
    pgn: "1. d4 *",
    pgnHash: "deadbeef00000002",
    finalFen: "fen-b",
    moveCount: 1,
    headers: {},
    createdAt: "2026-05-25T10:00:00.000Z",
  });
  cache.save({
    source: "manual",
    sourceGameId: null,
    sourceUrl: null,
    whiteUsername: "Second",
    blackUsername: "Game",
    result: "*",
    variant: null,
    timeControl: null,
    playedAt: null,
    pgn: "1. c4 *",
    pgnHash: "deadbeef00000003",
    finalFen: "fen-c",
    moveCount: 1,
    headers: {},
    createdAt: "2026-05-25T10:01:00.000Z",
  });

  cache.save({
    source: "manual",
    sourceGameId: null,
    sourceUrl: null,
    whiteUsername: "First",
    blackUsername: "Game",
    result: "*",
    variant: null,
    timeControl: null,
    playedAt: null,
    pgn: "1. d4 *",
    pgnHash: "deadbeef00000002",
    finalFen: "fen-b",
    moveCount: 1,
    headers: {},
    createdAt: "2026-05-25T10:00:00.000Z",
  });

  const [first, second] = cache.listRecentGames(2);
  assert.equal(first.pgnHash, "deadbeef00000002");
  assert.equal(second.pgnHash, "deadbeef00000003");
});
