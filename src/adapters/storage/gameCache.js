const STORAGE_KEY = "chess-trainer:game-cache:v1";
const MAX_GAMES = 24;

function emptySnapshot() {
  return {
    version: 1,
    games: {},
    order: [],
    sourceIndex: {},
    pgnIndex: {},
  };
}

function cloneRecord(record) {
  return {
    ...record,
    headers: record?.headers ? { ...record.headers } : {},
  };
}

function mergeRecords(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    headers: {
      ...(existing?.headers ?? {}),
      ...(incoming?.headers ?? {}),
    },
  };
}

function sourceLookupKey(source, sourceGameId) {
  if (!source || !sourceGameId) {
    return null;
  }
  return `${source}:${sourceGameId}`;
}

function compactSnapshot(snapshot) {
  const trimmedOrder = snapshot.order
    .filter((key) => snapshot.games[key])
    .slice(0, MAX_GAMES);

  const nextGames = {};
  for (const key of trimmedOrder) {
    nextGames[key] = snapshot.games[key];
  }

  const sourceIndex = {};
  const pgnIndex = {};
  for (const [key, record] of Object.entries(nextGames)) {
    if (record.pgnHash) {
      pgnIndex[record.pgnHash] = key;
    }
    const sourceKey = sourceLookupKey(record.source, record.sourceGameId);
    if (sourceKey) {
      sourceIndex[sourceKey] = key;
    }
  }

  return {
    version: 1,
    games: nextGames,
    order: trimmedOrder,
    sourceIndex,
    pgnIndex,
  };
}

function readSnapshot(storage) {
  if (!storage?.getItem) {
    return emptySnapshot();
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptySnapshot();
    }
    const parsed = JSON.parse(raw);
    return compactSnapshot({
      version: 1,
      games: parsed?.games ?? {},
      order: Array.isArray(parsed?.order) ? parsed.order : [],
      sourceIndex: parsed?.sourceIndex ?? {},
      pgnIndex: parsed?.pgnIndex ?? {},
    });
  } catch {
    return emptySnapshot();
  }
}

function writeSnapshot(storage, snapshot) {
  if (!storage?.setItem) {
    return false;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function createGameCache(storage = globalThis.localStorage) {
  function persist(nextSnapshot) {
    const compacted = compactSnapshot(nextSnapshot);
    writeSnapshot(storage, compacted);
    return compacted;
  }

  function readRecordByKey(key) {
    if (!key) {
      return null;
    }
    const snapshot = readSnapshot(storage);
    const record = snapshot.games[key];
    return record ? cloneRecord(record) : null;
  }

  return {
    listRecentGames(limit = MAX_GAMES) {
      const snapshot = readSnapshot(storage);
      return snapshot.order
        .slice(0, limit)
        .map((key) => snapshot.games[key])
        .filter(Boolean)
        .map(cloneRecord);
    },

    findBySourceGameId(source, sourceGameId) {
      const snapshot = readSnapshot(storage);
      return readRecordByKey(snapshot.sourceIndex[sourceLookupKey(source, sourceGameId)]);
    },

    findByPgnHash(pgnHash) {
      const snapshot = readSnapshot(storage);
      return readRecordByKey(snapshot.pgnIndex[pgnHash]);
    },

    save(record) {
      const snapshot = readSnapshot(storage);
      const now = new Date().toISOString();
      const desiredKey = sourceLookupKey(record.source, record.sourceGameId)
        ? `source:${sourceLookupKey(record.source, record.sourceGameId)}`
        : `pgn:${record.pgnHash}`;
      const existingKey = snapshot.sourceIndex[sourceLookupKey(record.source, record.sourceGameId)]
        ?? snapshot.pgnIndex[record.pgnHash]
        ?? null;
      const cacheKey = existingKey || desiredKey;
      const merged = mergeRecords(snapshot.games[cacheKey], record);
      merged.cachedAt = merged.cachedAt || now;
      merged.lastOpenedAt = now;

      snapshot.games[cacheKey] = merged;
      snapshot.order = [cacheKey, ...snapshot.order.filter((key) => key !== cacheKey)];
      const persisted = persist(snapshot);
      return cloneRecord(persisted.games[cacheKey] ?? merged);
    },
  };
}
