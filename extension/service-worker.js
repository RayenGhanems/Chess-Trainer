const DEFAULT_APP_ORIGIN = "http://127.0.0.1:8000";
const APP_ORIGIN_KEY = "reviewAppOrigin";
const PUBAPI_ROOT = "https://api.chess.com/pub";
const CHESSCOM_GAME_PATTERNS = [
  /^https:\/\/(?:www\.)?chess\.com\/game\/(\d+)\/?/i,
  /^https:\/\/(?:www\.)?chess\.com\/game\/(?:live|daily|computer)\/(\d+)\/?/i,
  /^https:\/\/(?:www\.)?chess\.com\/analysis\/game\/(\d+)\/?/i,
  /^https:\/\/(?:www\.)?chess\.com\/analysis\/game\/(?:live|daily|computer)\/(\d+)\/?/i,
];

function normalizeAppOrigin(value) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_APP_ORIGIN;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Review app origin must use http or https.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function hostPermissionPatternForOrigin(origin) {
  const normalized = normalizeAppOrigin(origin);
  const parsed = new URL(normalized);
  return `${parsed.origin}/*`;
}

async function getReviewAppOrigin() {
  const stored = await chrome.storage.sync.get(APP_ORIGIN_KEY);
  return normalizeAppOrigin(stored[APP_ORIGIN_KEY]);
}

async function ensureReviewAppOriginPermission(appOrigin) {
  const normalized = normalizeAppOrigin(appOrigin);
  if (normalized === DEFAULT_APP_ORIGIN) {
    return;
  }

  const originPattern = hostPermissionPatternForOrigin(normalized);
  const alreadyAllowed = await chrome.permissions.contains({
    origins: [originPattern],
  });
  if (alreadyAllowed) {
    return;
  }

  const granted = await chrome.permissions.request({
    origins: [originPattern],
  });
  if (!granted) {
    throw new Error("Review app host permission was not granted.");
  }
}

function extractGameIdFromUrl(url) {
  for (const pattern of CHESSCOM_GAME_PATTERNS) {
    const match = String(url).match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function canonicalLiveGameUrlFromId(gameId) {
  return gameId ? `https://www.chess.com/game/live/${gameId}` : null;
}

function parsePlayersFromTitle(title) {
  const match = String(title || "").match(/^Chess:\s+(.+?)\s+vs\s+(.+?)(?:\s+-\s+\d+)?\s+-\s+Chess\.com$/i);
  if (!match) {
    return null;
  }
  return {
    white: match[1].trim(),
    black: match[2].trim(),
  };
}

function archiveMonthCandidates(capturedAt) {
  const base = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(base.getTime())) {
    return [];
  }

  const candidates = [];
  for (let offset = 0; offset < 2; offset += 1) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - offset, 1));
    candidates.push({
      year: date.getUTCFullYear(),
      month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    });
  }
  return candidates;
}

async function fetchPubApiGames(username, year, month) {
  const response = await fetch(`${PUBAPI_ROOT}/player/${encodeURIComponent(username)}/games/${year}/${month}`, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`PubAPI lookup failed for ${username} ${year}/${month} with HTTP ${response.status}.`);
  }
  const body = await response.json();
  return Array.isArray(body?.games) ? body.games : [];
}

async function findPubApiPgn(sourceGameId, usernames, capturedAt) {
  const canonicalUrl = canonicalLiveGameUrlFromId(sourceGameId);
  if (!sourceGameId || !canonicalUrl || !Array.isArray(usernames) || !usernames.length) {
    return null;
  }

  const seenUsers = new Set();
  const dedupedUsers = usernames.filter((username) => {
    const key = String(username || "").trim().toLowerCase();
    if (!key || seenUsers.has(key)) {
      return false;
    }
    seenUsers.add(key);
    return true;
  });

  for (const username of dedupedUsers) {
    for (const { year, month } of archiveMonthCandidates(capturedAt)) {
      try {
        const games = await fetchPubApiGames(username, year, month);
        const match = games.find((game) => game?.url === canonicalUrl || extractGameIdFromUrl(game?.url) === sourceGameId);
        if (match?.pgn) {
          console.info("PubAPI matched game PGN", { sourceGameId, username, year, month });
          return match.pgn;
        }
      } catch (error) {
        console.warn("PubAPI fallback skipped:", error.message || error);
      }
    }
  }

  return null;
}

function collectChessComImportPayload() {
  function parsePlayersFromTitle(title) {
    const match = String(title || "").match(/^Chess:\s+(.+?)\s+vs\s+(.+?)(?:\s+-\s+\d+)?\s+-\s+Chess\.com$/i);
    if (!match) {
      return null;
    }
    return {
      white: match[1].trim(),
      black: match[2].trim(),
    };
  }

  function decodeEscapedJsonString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return null;
    }
  }

  function trimText(value, maxChars) {
    return typeof value === "string" && value.length > maxChars ? value.slice(0, maxChars) : value;
  }

  function normalizeUsername(value) {
    const normalized = String(value || "")
      .trim()
      .replace(/^@+/, "");
    return normalized || null;
  }

  function normalizeToken(token) {
    return String(token || "")
      .trim()
      .replace(/^(\d+)\.(\.\.)?$/, "")
      .replace(/[?!]+$/g, "")
      .replace(/^0-0-0$/i, "O-O-O")
      .replace(/^0-0$/i, "O-O");
  }

  function isResultToken(token) {
    return /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token);
  }

  function isSanToken(token) {
    return /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8](?:=[QRBN])?[+#]?)$/.test(token);
  }

  function tokenizeMoveText(text) {
    return String(text || "")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/\d+\.(?:\.\.)?/g, " ")
      .split(/\s+/)
      .map(normalizeToken)
      .filter((token) => token && (isSanToken(token) || isResultToken(token)));
  }

  function uniqueMoves(moves) {
    const result = [];
    for (const move of moves) {
      if (!move) {
        continue;
      }
      if (isResultToken(move)) {
        continue;
      }
      if (result[result.length - 1] !== move) {
        result.push(move);
      }
    }
    return result;
  }

  function extractHeadersFromMeta(sourceUrl, pageTitle) {
    const description = document.querySelector('meta[name="description"]')?.getAttribute("content") || "";
    const headers = {
      Site: "Chess.com",
      Link: sourceUrl,
    };

    const titlePlayers = parsePlayersFromTitle(pageTitle);
    if (titlePlayers) {
      headers.White = titlePlayers.white;
      headers.Black = titlePlayers.black;
    }

    const match = description.match(/^(.+?)\s+\((?:[^)]+)\)\s+vs\s+(.+?)\s+\((?:[^)]+)\)\.\s+(.+?)\.\s+Click to review/i);
    if (!match) {
      return headers;
    }

    headers.White = match[1].trim();
    headers.Black = match[2].trim();

    const summary = match[3].trim();
    const summaryLower = summary.toLowerCase();
    if (summaryLower.includes("draw")) {
      headers.Result = "1/2-1/2";
    } else if (summaryLower.startsWith(headers.White.toLowerCase())) {
      headers.Result = "1-0";
    } else if (summaryLower.startsWith(headers.Black.toLowerCase())) {
      headers.Result = "0-1";
    }

    if (summaryLower.includes("won on time")) {
      headers.Termination = "Time forfeit";
    } else if (summaryLower.includes("won by checkmate")) {
      headers.Termination = "Checkmate";
    } else if (summaryLower.includes("won by resignation")) {
      headers.Termination = "Resignation";
    }

    return headers;
  }

  function extractPlayerUsernames() {
    const selectors = [
      '[data-test-element="user-tagline-username"]',
      '.cc-user-username-component',
      '[class*="user-username"]',
    ];
    const usernames = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const username = String(element.textContent || "").trim();
        if (username && !usernames.includes(username)) {
          usernames.push(username);
        }
      }
      if (usernames.length >= 2) {
        break;
      }
    }
    return usernames.slice(0, 4);
  }

  function extractViewerUsername() {
    const directCandidates = [
      window.context?.user?.username,
      window.context?.user?.usernameLower,
      window.chesscom?.user?.username,
      document.querySelector("#notifications-request[username]")?.getAttribute("username"),
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === "string" && candidate.includes("/member/")) {
        try {
          const parsed = new URL(candidate, window.location.origin);
          const match = parsed.pathname.match(/^\/member\/([^/?#]+)\/?$/i);
          const username = normalizeUsername(match?.[1]);
          if (username) {
            return username;
          }
        } catch {
          // Ignore malformed member links and keep looking.
        }
      }

      const username = normalizeUsername(candidate);
      if (username) {
        return username;
      }
    }

    const memberLinkSelectors = [
      '[data-test-element="nav-user-menu"] a[href*="/member/"]',
      '[data-test-element="user-navigation"] a[href*="/member/"]',
      'header a[href*="/member/"]',
      '[data-test-element="home-user-tagline"] a[href*="/member/"]',
      '[href*="/member/"][aria-current="page"]',
    ];
    for (const selector of memberLinkSelectors) {
      const anchor = document.querySelector(selector);
      const href = anchor?.getAttribute("href") || anchor?.href || "";
      if (!href) {
        continue;
      }
      try {
        const parsed = new URL(href, window.location.origin);
        const match = parsed.pathname.match(/^\/member\/([^/?#]+)\/?$/i);
        const username = normalizeUsername(match?.[1]);
        if (username) {
          return username;
        }
      } catch {
        // Ignore malformed member links and keep scanning.
      }
    }

    return null;
  }

  function candidateQuality(tokens) {
    let invalidLike = 0;
    for (const token of tokens) {
      if (/^[a-h]{2}[1-8][+#]?$/i.test(token) || /^x[a-h][1-8]/i.test(token)) {
        invalidLike += 1;
      }
    }
    return invalidLike;
  }

  function extractTokensFromExplorerLink(href) {
    if (!href || !String(href).includes("moveList=")) {
      return [];
    }

    try {
      const resolved = new URL(String(href), window.location.origin);
      const moveList = resolved.searchParams.get("moveList") || "";
      return uniqueMoves(tokenizeMoveText(moveList));
    } catch {
      return [];
    }
  }

  function extractTokenFromMoveNode(element) {
    if (!element) {
      return null;
    }

    const figurinePrefix = Array.from(element.querySelectorAll("[data-figurine]"))
      .map((node) => node.getAttribute("data-figurine") || "")
      .join("");

    const clone = element.cloneNode(true);
    clone.querySelectorAll("[data-figurine]").forEach((node) => node.remove());
    const text = `${figurinePrefix}${clone.textContent || ""}`
      .replace(/\s+/g, "")
      .trim();
    const normalized = normalizeToken(text);
    return normalized && isSanToken(normalized) ? normalized : null;
  }

  function extractMoveCandidatesFromDom() {
    const candidates = [];
    const explorerAnchors = Array.from(document.querySelectorAll('a[href*="moveList="]'));
    for (const anchor of explorerAnchors) {
      const tokens = extractTokensFromExplorerLink(anchor.getAttribute("href") || anchor.href || "");
      if (tokens.length >= 6) {
        candidates.push({
          source: "explorer-moveList",
          moves: tokens,
          invalidLike: candidateQuality(tokens),
        });
      }
      if (candidates.length) {
        break;
      }
    }

    const moveNodes = Array.from(document.querySelectorAll("[data-node] .node-highlight-content"));
    const nodeMoves = uniqueMoves(moveNodes.map(extractTokenFromMoveNode).filter(Boolean));
    if (nodeMoves.length >= 6) {
      candidates.push({
        source: "structured-node-content",
        moves: nodeMoves,
        invalidLike: candidateQuality(nodeMoves),
      });
    }

    const selectors = [
      '[data-whole-move-number]',
      '[class*="move-list"] button',
      '[class*="move-list"] span',
      '[class*="moves"] button',
      '[class*="moves"] span',
      '[class*="notation"] button',
      '[class*="notation"] span',
      '[class*="vertical"] button',
      '[class*="vertical"] span',
      '[class*="move"] button',
      '[class*="move"] span',
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      if (!elements.length) {
        continue;
      }
      const tokens = uniqueMoves(elements.flatMap((element) => tokenizeMoveText(element.textContent || "")));
      if (tokens.length >= 6) {
        candidates.push({
          source: selector,
          moves: tokens,
          invalidLike: candidateQuality(tokens),
        });
      }
    }

    const bodyTokens = uniqueMoves(tokenizeMoveText(document.body?.innerText || ""));
    if (bodyTokens.length >= 6) {
      candidates.push({
        source: "document.body",
        moves: bodyTokens,
        invalidLike: candidateQuality(bodyTokens),
      });
    }

    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = candidate.moves.join(" ");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(candidate);
    }

    deduped.sort((left, right) => {
      if (left.invalidLike !== right.invalidLike) {
        return left.invalidLike - right.invalidLike;
      }
      const bodyBiasLeft = left.source === "document.body" ? 1 : 0;
      const bodyBiasRight = right.source === "document.body" ? 1 : 0;
      if (bodyBiasLeft !== bodyBiasRight) {
        return bodyBiasLeft - bodyBiasRight;
      }
      return right.moves.length - left.moves.length;
    });

    return deduped.slice(0, 8);
  }

  const sourceUrl = window.location.href;
  const sourceGameId = (() => {
    for (const pattern of [
      /^https:\/\/(?:www\.)?chess\.com\/game\/(\d+)\/?/i,
      /^https:\/\/(?:www\.)?chess\.com\/game\/(?:live|daily|computer)\/(\d+)\/?/i,
      /^https:\/\/(?:www\.)?chess\.com\/analysis\/game\/(\d+)\/?/i,
      /^https:\/\/(?:www\.)?chess\.com\/analysis\/game\/(?:live|daily|computer)\/(\d+)\/?/i,
    ]) {
      const match = sourceUrl.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  })();

  if (!sourceGameId) {
    throw new Error("This page does not look like a supported Chess.com game URL.");
  }

  const html = document.documentElement?.outerHTML || "";
  const embeddedPgnMatch = html.match(/"pgn"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  const embeddedPgn = embeddedPgnMatch ? decodeEscapedJsonString(embeddedPgnMatch[1]) : null;
  const pageTitle = document.title || null;
  const headers = extractHeadersFromMeta(sourceUrl, pageTitle);
  const playerUsernames = extractPlayerUsernames();
  const viewerUsername = extractViewerUsername();
  const moveCandidates = embeddedPgn ? [] : extractMoveCandidatesFromDom();
  const moves = moveCandidates[0]?.moves || [];
  const directPgn =
    embeddedPgn
    || document.querySelector("[data-pgn]")?.getAttribute("data-pgn")
    || null;

  const payload = {
    source: "chesscom",
    sourceGameId,
    sourceUrl,
    headers,
    playerUsernames,
    viewerUsername,
    moves,
    moveCandidates,
    pgn: directPgn ? trimText(directPgn, 900000) : null,
    importedText: directPgn ? null : trimText(html, 900000),
    pageTitle,
    extraction: directPgn
      ? "embedded-pgn"
      : moveCandidates[0]?.source === "explorer-moveList"
        ? "explorer-move-list"
        : moveCandidates[0]?.source === "structured-node-content"
          ? "structured-node-list"
          : moveCandidates.length
            ? "visible-san-list"
            : "page-html",
    capturedAt: new Date().toISOString(),
  };

  if (!payload.pgn && !payload.importedText && !payload.moves.length && !payload.moveCandidates.length) {
    throw new Error("Could not capture importable game data from this page.");
  }

  return payload;
}

async function createImportRecord(appOrigin, payload) {
  const response = await fetch(`${appOrigin}/api/import-record`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || !body?.token || !body?.review_url) {
    throw new Error(body?.error || `Review app import failed with HTTP ${response.status}.`);
  }
  return body;
}

async function enrichPayloadWithPubApiPgn(payload) {
  if (payload?.pgn) {
    return payload;
  }

  const usernames = [
    payload?.headers?.White,
    payload?.headers?.Black,
    ...(Array.isArray(payload?.playerUsernames) ? payload.playerUsernames : []),
  ].filter(Boolean);
  const pgn = await findPubApiPgn(payload?.sourceGameId, usernames, payload?.capturedAt);
  if (!pgn) {
    return payload;
  }

  return {
    ...payload,
    pgn,
    extraction: "pubapi-monthly-archive",
  };
}

async function handleActionClick(tab) {
  if (!tab.id || !tab.url) {
    throw new Error("Active tab is missing its URL.");
  }
  if (!extractGameIdFromUrl(tab.url)) {
    throw new Error("Open a Chess.com game page before using the extension.");
  }

  const appOrigin = await getReviewAppOrigin();
  await ensureReviewAppOriginPermission(appOrigin);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectChessComImportPayload,
  });
  if (!result?.result) {
    throw new Error("Could not read the game page.");
  }

  const payload = await enrichPayloadWithPubApiPgn(result.result);
  console.info("Prepared import payload", {
    sourceGameId: payload?.sourceGameId,
    extraction: payload?.extraction,
    hasPgn: Boolean(payload?.pgn),
  });
  const created = await createImportRecord(appOrigin, payload);
  await chrome.tabs.create({ url: `${appOrigin}${created.review_url}` });
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(APP_ORIGIN_KEY);
  if (!stored[APP_ORIGIN_KEY]) {
    await chrome.storage.sync.set({ [APP_ORIGIN_KEY]: DEFAULT_APP_ORIGIN });
  }
});

chrome.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch((error) => {
    console.error("Review import failed:", error);
  });
});
