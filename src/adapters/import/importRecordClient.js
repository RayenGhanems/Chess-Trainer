export async function fetchImportedRecordFromToken(token, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This browser does not support fetch.");
  }

  const response = await fetchImpl(`/api/import-record/${encodeURIComponent(token)}`);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Fall back to HTTP status below.
  }

  if (!response.ok || !payload?.ok || !payload?.payload) {
    throw new Error(payload?.error || `Import handoff failed with HTTP ${response.status}.`);
  }

  return payload.payload;
}
