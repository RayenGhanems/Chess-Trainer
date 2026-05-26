export async function fetchImportedTextFromUrl(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This browser does not support fetch.");
  }

  const response = await fetchImpl(`/api/import-game?url=${encodeURIComponent(url)}`);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Leave payload null and fall back to the HTTP status below.
  }

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Import failed with HTTP ${response.status}.`);
  }

  return payload.text;
}
