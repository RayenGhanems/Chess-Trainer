import { applyMove, cloneState, generateFen } from "./chess.js";

const DEFAULT_RESULT = "*";
const DEFAULT_SOURCE = "manual";
const CHESSCOM_SOURCE = "chesscom";
const HEADER_ORDER = [
  "Event",
  "Site",
  "Date",
  "Round",
  "White",
  "Black",
  "Result",
  "SetUp",
  "FEN",
  "UTCDate",
  "UTCTime",
  "StartTime",
  "EndTime",
  "WhiteElo",
  "BlackElo",
  "TimeControl",
  "Variant",
  "ECO",
  "Opening",
  "Termination",
  "Link",
];
const CHESSCOM_GAME_PATHS = [
  /^\/game\/(\d+)\/?$/i,
  /^\/game\/(?:live|daily|computer)\/(\d+)\/?$/i,
  /^\/analysis\/game\/(\d+)\/?$/i,
  /^\/analysis\/game\/(?:live|daily|computer)\/(\d+)\/?$/i,
];

function normalizeString(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeUsername(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/^@+/, "") || null;
}

function usernamesMatch(left, right) {
  const normalizedLeft = normalizeUsername(left);
  const normalizedRight = normalizeUsername(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft.localeCompare(normalizedRight, undefined, { sensitivity: "accent" }) === 0;
}

function normalizeViewerColor(value) {
  return value === "w" || value === "b" ? value : null;
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const text = normalizeString(value);
    if (text) {
      normalized[key] = text;
    }
  }
  return normalized;
}

function normalizeResult(value) {
  const result = normalizeString(value);
  if (result && ["1-0", "0-1", "1/2-1/2", "*"].includes(result)) {
    return result;
  }
  return DEFAULT_RESULT;
}

function escapePgnHeaderValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"");
}

function orderedHeaderKeys(headers) {
  const known = HEADER_ORDER.filter((key) => key in headers);
  const remaining = Object.keys(headers)
    .filter((key) => !HEADER_ORDER.includes(key))
    .sort((left, right) => left.localeCompare(right));
  return [...known, ...remaining];
}

function buildMovetextFromSanMoves(moves, initialTurn = "w", initialFullmove = 1, result = DEFAULT_RESULT) {
  const tokens = [];
  let moveNumber = Number.isInteger(initialFullmove) && initialFullmove > 0 ? initialFullmove : 1;
  let turn = initialTurn === "b" ? "b" : "w";

  for (const san of moves) {
    if (turn === "w") {
      tokens.push(`${moveNumber}.`, san);
      turn = "b";
      continue;
    }

    if (!tokens.length) {
      tokens.push(`${moveNumber}...`);
    }
    tokens.push(san);
    moveNumber += 1;
    turn = "w";
  }

  tokens.push(normalizeResult(result));
  return tokens.join(" ");
}

function buildCanonicalMovetext(record) {
  return buildMovetextFromSanMoves(
    record.moves.map((entry) => entry.san),
    record.initialState.turn,
    record.initialState.fullmove,
    record.headers.Result,
  );
}

function buildCanonicalPgn(record, headers) {
  const headerText = orderedHeaderKeys(headers)
    .map((key) => `[${key} "${escapePgnHeaderValue(headers[key])}"]`)
    .join("\n");
  const movetext = buildCanonicalMovetext(record);
  return headerText ? `${headerText}\n\n${movetext}` : movetext;
}

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (const symbol of text) {
    hash ^= BigInt(symbol.codePointAt(0));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  return hash.toString(16).padStart(16, "0");
}

function normalizeDatePart(value, separatorPattern) {
  const text = normalizeString(value);
  if (!text || text.includes("?")) {
    return null;
  }
  const match = text.match(separatorPattern);
  if (!match) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeTimePart(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  const match = text.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
}

function derivePlayedAt(headers) {
  const utcDate = normalizeDatePart(headers.UTCDate, /^(\d{4})\.(\d{2})\.(\d{2})$/);
  const utcTime = normalizeTimePart(headers.UTCTime);
  if (utcDate && utcTime) {
    return `${utcDate}T${utcTime}Z`;
  }

  const localDate = normalizeDatePart(headers.Date, /^(\d{4})[.\-](\d{2})[.\-](\d{2})$/);
  if (localDate) {
    return localDate;
  }

  return null;
}

function isChessComHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "chess.com" || normalized.endsWith(".chess.com");
}

function normalizeSourceUrl(url) {
  const parsed = new URL(url);
  const normalized = new URL(parsed.pathname, "https://www.chess.com");
  normalized.search = parsed.search;
  return normalized.toString();
}

function extractGameIdFromPath(pathname) {
  for (const pattern of CHESSCOM_GAME_PATHS) {
    const match = pathname.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function deriveSourceRef(headers, options) {
  const candidates = [options.sourceUrl, headers.Link, headers.Site]
    .map((value) => normalizeString(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    const ref = extractChessComGameRef(candidate);
    if (ref) {
      return ref;
    }
  }

  return null;
}

function computeFinalState(record) {
  let state = cloneState(record.initialState);
  for (const entry of record.moves) {
    state = applyMove(state, entry.move);
  }
  return state;
}

export function extractChessComGameRef(url) {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return null;
  }

  if (!isChessComHost(parsed.hostname)) {
    return null;
  }

  const sourceGameId = extractGameIdFromPath(parsed.pathname);
  if (!sourceGameId) {
    return null;
  }

  return {
    source: CHESSCOM_SOURCE,
    sourceGameId,
    sourceUrl: normalizeSourceUrl(parsed.toString()),
  };
}

export function routePathForRecord(record) {
  if (record?.source && record?.sourceGameId) {
    return `/game/${encodeURIComponent(record.source)}/${encodeURIComponent(record.sourceGameId)}`;
  }
  return `/game/local/${encodeURIComponent(record?.pgnHash ?? "")}`;
}

export function buildImportTokenRoute(token) {
  return `/import/${encodeURIComponent(token)}`;
}

export function parseGameRoute(pathname) {
  const normalizedPath = normalizeString(pathname) || "/";
  const match = normalizedPath.match(/^\/game\/([^/]+)\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }

  const source = decodeURIComponent(match[1]);
  const value = decodeURIComponent(match[2]);
  if (!source || !value) {
    return null;
  }

  if (source === "local") {
    return { pgnHash: value };
  }

  return {
    source,
    sourceGameId: value,
  };
}

export function parseImportTokenRoute(pathname) {
  const normalizedPath = normalizeString(pathname) || "/";
  const match = normalizedPath.match(/^\/import\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  const token = decodeURIComponent(match[1]);
  return token ? { token } : null;
}

export function buildPgnFromSanMoves(headers = {}, moves = []) {
  const normalizedHeaders = normalizeHeaders(headers);
  const sanitizedMoves = moves
    .map((move) => normalizeString(move))
    .filter(Boolean);

  if (!sanitizedMoves.length) {
    throw new Error("Structured import needs at least one SAN move.");
  }

  if (!normalizedHeaders.Result) {
    normalizedHeaders.Result = DEFAULT_RESULT;
  }

  const headerText = orderedHeaderKeys(normalizedHeaders)
    .map((key) => `[${key} "${escapePgnHeaderValue(normalizedHeaders[key])}"]`)
    .join("\n");
  const movetext = buildMovetextFromSanMoves(sanitizedMoves, "w", 1, normalizedHeaders.Result);
  return headerText ? `${headerText}\n\n${movetext}` : movetext;
}

export function buildNormalizedGameRecord(record, options = {}) {
  const headers = normalizeHeaders(record.headers);
  const sourceRef = deriveSourceRef(headers, options);
  const source = normalizeString(options.source) || sourceRef?.source || DEFAULT_SOURCE;
  const sourceGameId = normalizeString(options.sourceGameId) || sourceRef?.sourceGameId || null;
  const sourceUrl = normalizeString(options.sourceUrl) || sourceRef?.sourceUrl || null;
  const viewerUsername = normalizeUsername(options.viewerUsername);
  const finalState = computeFinalState(record);
  const canonicalHeaders = { ...headers };

  if (sourceUrl && !canonicalHeaders.Link) {
    canonicalHeaders.Link = sourceUrl;
  }
  if (source === CHESSCOM_SOURCE && !canonicalHeaders.Site) {
    canonicalHeaders.Site = "Chess.com";
  }
  if (!canonicalHeaders.Result) {
    canonicalHeaders.Result = DEFAULT_RESULT;
  }

  let viewerColor = normalizeViewerColor(options.viewerColor);
  if (!viewerColor && viewerUsername) {
    if (usernamesMatch(viewerUsername, canonicalHeaders.White)) {
      viewerColor = "w";
    } else if (usernamesMatch(viewerUsername, canonicalHeaders.Black)) {
      viewerColor = "b";
    }
  }

  const pgn = buildCanonicalPgn(record, canonicalHeaders);
  return {
    source,
    sourceGameId,
    sourceUrl,
    whiteUsername: normalizeString(canonicalHeaders.White),
    blackUsername: normalizeString(canonicalHeaders.Black),
    result: normalizeResult(canonicalHeaders.Result),
    variant: normalizeString(canonicalHeaders.Variant),
    timeControl: normalizeString(canonicalHeaders.TimeControl),
    playedAt: derivePlayedAt(canonicalHeaders),
    pgn,
    pgnHash: fnv1a64(pgn),
    finalFen: generateFen(finalState),
    moveCount: record.moves.length,
    headers: canonicalHeaders,
    viewerUsername,
    viewerColor,
    createdAt: normalizeString(options.createdAt) || new Date().toISOString(),
  };
}
