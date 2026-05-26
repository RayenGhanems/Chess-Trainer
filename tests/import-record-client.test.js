import test from "node:test";
import assert from "node:assert/strict";

import { fetchImportedRecordFromToken } from "../src/adapters/import/importRecordClient.js";

test("fetchImportedRecordFromToken returns payload on success", async () => {
  const payload = await fetchImportedRecordFromToken("abc12345", async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        payload: {
          source: "chesscom",
          sourceGameId: "169208992842",
          pgn: "1. e4 e5 1-0",
        },
      };
    },
  }));

  assert.equal(payload.source, "chesscom");
  assert.equal(payload.sourceGameId, "169208992842");
});

test("fetchImportedRecordFromToken surfaces server errors", async () => {
  await assert.rejects(
    () => fetchImportedRecordFromToken("abc12345", async () => ({
      ok: false,
      status: 404,
      async json() {
        return { ok: false, error: "Import record not found." };
      },
    })),
    /Import record not found/,
  );
});
