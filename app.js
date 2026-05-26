import {
  FILES,
  PIECE_GLYPHS,
  PROMOTION_TYPES,
  cloneState,
  colorName,
  coordsToIndex,
  createInitialState,
  formatSanMove,
  findKing,
  generateFen,
  generateLegalMoves,
  getGameResult,
  indexToCoords,
  moveToUci,
  oppositeColor,
  parseImportedGame,
  parseUciMove,
  squareName,
  applyMove,
} from "./src/domain/chess.js";
import {
  buildMoveFeedback,
  evalFillPercent,
  formatScore,
  formatWhitePerspectiveNumeric,
  whitePerspectiveScore,
} from "./src/domain/review.js";
import {
  buildPgnFromSanMoves,
  buildNormalizedGameRecord,
  extractChessComGameRef,
  parseImportTokenRoute,
  parseGameRoute,
  routePathForRecord,
} from "./src/domain/import.js";
import { StockfishBridge } from "./src/adapters/engine/stockfishBridge.js";
import { fetchImportedTextFromUrl } from "./src/adapters/import/chessComImportClient.js";
import { fetchImportedRecordFromToken } from "./src/adapters/import/importRecordClient.js";
import { createGameCache } from "./src/adapters/storage/gameCache.js";

const PIECE_IMAGE_BASE_URL = "https://www.chess.com/chess-themes/pieces/neo/300";

const FEEDBACK_PRESENTATIONS = {
  brilliant: { symbol: "!!", label: "Brilliant", color: "#2fd7c4" },
  great: { symbol: "!", label: "Great", color: "#7fb2ff" },
  best: { symbol: "★", label: "Best", color: "#83cf51" },
  excellent: { symbol: "✓+", label: "Excellent", color: "#63bb47" },
  good: { symbol: "✓", label: "Good", color: "#5aa03d" },
  inaccuracy: { symbol: "?!", label: "Inaccuracy", color: "#f2c04a" },
  mistake: { symbol: "?", label: "Mistake", color: "#ff9d49" },
  miss: { symbol: "×", label: "Miss", color: "#ff7b6b" },
  blunder: { symbol: "??", label: "Blunder", color: "#ff5146" },
  pending: { symbol: "…", label: "Grading", color: "#c9d1c2" },
};

const MOVE_KEY_ITEMS = [
  ["brilliant", "Best sacrifice or standout tactical idea."],
  ["great", "Best move in a critical moment."],
  ["best", "Matched Stockfish's top move."],
  ["excellent", "Very close to best, usually 0-25 cp lost."],
  ["good", "Solid move, usually 26-80 cp lost."],
  ["inaccuracy", "Small slip, usually 81-160 cp lost."],
  ["mistake", "Clear drop, usually 161-300 cp lost."],
  ["blunder", "Big drop, usually more than 300 cp lost."],
  ["miss", "Missed a strong chance or winning idea."],
];

const REVIEW_SUMMARY_TONES = ["brilliant", "great", "best", "mistake", "miss", "blunder"];
const IMPORT_HISTORY_LIMIT = 8;

const elements = {
  board: document.querySelector("#board"),
  boardStage: document.querySelector(".board-stage"),
  boardOverlay: document.querySelector("#board-overlay"),
  endOverlay: document.querySelector("#end-overlay"),
  dragLayer: document.querySelector("#drag-layer"),
  reviewSummary: document.querySelector("#review-summary-panel"),
  moveTree: document.querySelector("#move-tree"),
  branchList: document.querySelector("#branch-list"),
  moveKey: document.querySelector("#move-key"),
  engineStatus: document.querySelector("#engine-status"),
  turnPill: document.querySelector("#turn-pill"),
  scoreValue: document.querySelector("#score-value"),
  evalBarFill: document.querySelector("#eval-bar-fill"),
  lastFeedback: document.querySelector("#last-feedback"),
  bestMove: document.querySelector("#best-move"),
  statusText: document.querySelector("#status-text"),
  fenOutput: document.querySelector("#fen-output"),
  treeSummary: document.querySelector("#tree-summary"),
  branchSummary: document.querySelector("#branch-summary"),
  playerColor: document.querySelector("#player-color"),
  depthInput: document.querySelector("#depth-input"),
  depthValue: document.querySelector("#depth-value"),
  replyDelayInput: document.querySelector("#reply-delay-input"),
  replyDelayValue: document.querySelector("#reply-delay-value"),
  showBestArrow: document.querySelector("#show-best-arrow"),
  newGame: document.querySelector("#new-game-btn"),
  firstBtn: document.querySelector("#first-btn"),
  backBtn: document.querySelector("#back-btn"),
  forwardBtn: document.querySelector("#forward-btn"),
  latestBtn: document.querySelector("#latest-btn"),
  flipBtn: document.querySelector("#flip-btn"),
  promotionModal: document.querySelector("#promotion-modal"),
  promotionOptions: document.querySelector("#promotion-options"),
  importUrl: document.querySelector("#import-url"),
  importPgn: document.querySelector("#import-pgn"),
  importButton: document.querySelector("#import-game-btn"),
  importStatus: document.querySelector("#import-status"),
  importPermalink: document.querySelector("#import-permalink"),
  importHistory: document.querySelector("#import-history"),
};

function defaultCoachDepth() {
  const maxDepth = Number(elements.depthInput?.max);
  if (Number.isFinite(maxDepth) && maxDepth > 0) {
    return maxDepth;
  }
  const fallbackDepth = Number(elements.depthInput?.value);
  return Number.isFinite(fallbackDepth) && fallbackDepth > 0 ? fallbackDepth : 16;
}

const DEFAULT_COACH_DEPTH = defaultCoachDepth();
if (elements.depthInput) {
  elements.depthInput.value = String(DEFAULT_COACH_DEPTH);
}
if (elements.depthValue) {
  elements.depthValue.textContent = String(DEFAULT_COACH_DEPTH);
}

const app = {
  nodes: new Map(),
  rootId: null,
  currentNodeId: null,
  latestNodeId: null,
  mode: "play",
  playerColor: "w",
  orientation: "w",
  depth: DEFAULT_COACH_DEPTH,
  engineReplyDelayMs: Number(elements.replyDelayInput.value) * 1000,
  selectedSquare: null,
  pendingPromotion: null,
  showBestArrow: true,
  gameHeaders: {},
  importedResult: null,
  importedResultNodeId: null,
  importedMainlineIds: [],
  importedMainlineSet: new Set(),
  dragging: null,
  suppressClick: false,
  importBusy: false,
  reviewWarmupRunId: 0,
  reviewWarmup: {
    active: false,
    pending: false,
    totalMoves: 0,
    doneMoves: 0,
    currentNodeId: null,
  },
  engineRequestSerial: 0,
  awaitingEngineNodeId: null,
  pendingEngineReply: null,
  engineReady: false,
  engine: null,
  gameCache: createGameCache(),
  recentImports: [],
  currentImportedGame: null,
};

let nodeCounter = 0;

function nextNodeId() {
  nodeCounter += 1;
  return `node-${nodeCounter}`;
}

function currentImportedGameKey(record = app.currentImportedGame) {
  if (!record) {
    return null;
  }
  if (record.source && record.sourceGameId) {
    return `${record.source}:${record.sourceGameId}`;
  }
  return record.pgnHash ?? null;
}

function importRecordTitle(record) {
  const whiteName = record?.whiteUsername || record?.headers?.White || "White";
  const blackName = record?.blackUsername || record?.headers?.Black || "Black";
  return `${whiteName} vs ${blackName}`;
}

function sourceLabel(record) {
  return record?.source === "chesscom" ? "Chess.com" : "Local PGN";
}

function formatImportDate(value) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function replaceBrowserPath(pathname) {
  if (!window.history?.replaceState) {
    return;
  }
  const nextUrl = new URL(window.location.href);
  nextUrl.pathname = pathname;
  nextUrl.search = "";
  nextUrl.hash = "";
  window.history.replaceState(null, "", nextUrl);
}

function syncRouteForImportedGame(record) {
  if (!record) {
    replaceBrowserPath("/");
    return;
  }
  replaceBrowserPath(routePathForRecord(record));
}

function refreshImportHistory() {
  app.recentImports = app.gameCache.listRecentGames(IMPORT_HISTORY_LIMIT);
}

function isNormalizedImportedGameRecord(record) {
  return Boolean(
    record
    && typeof record === "object"
    && typeof record.pgn === "string"
    && typeof record.pgnHash === "string"
    && !("initialState" in record),
  );
}

function finalizeImportedGameCache(recordOrParsedRecord, metadata = {}) {
  const normalizedRecord = isNormalizedImportedGameRecord(recordOrParsedRecord)
    ? recordOrParsedRecord
    : buildNormalizedGameRecord(recordOrParsedRecord, metadata);
  const cachedRecord = app.gameCache.save(normalizedRecord);
  app.currentImportedGame = cachedRecord;
  refreshImportHistory();
  syncRouteForImportedGame(cachedRecord);
  renderImportPermalink();
  renderImportHistory();
  return cachedRecord;
}

function normalizeImportedSanToken(token) {
  return String(token || "")
    .trim()
    .replace(/^(\d+)\.(\.\.)?$/, "")
    .replace(/[?!]+$/g, "")
    .replace(/^0-0-0$/i, "O-O-O")
    .replace(/^0-0$/i, "O-O");
}

function isImportedSanToken(token) {
  return /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8](?:=[QRBN])?[+#]?)$/.test(token);
}

function tokenizeImportedMoveText(text) {
  return String(text || "")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\d+\.(?:\.\.)?/g, " ")
    .split(/\s+/)
    .map(normalizeImportedSanToken)
    .filter((token) => token && isImportedSanToken(token));
}

function extractMoveCandidatesFromImportedHtml(importedText) {
  const html = typeof importedText === "string" ? importedText : "";
  if (!html || !/<(?:!doctype\s+html|html)\b/i.test(html)) {
    return [];
  }

  const candidates = [];
  const hrefPattern = /href="([^"]*moveList=[^"]+)"/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1].replaceAll("&amp;", "&");
    try {
      const resolved = new URL(href, "https://www.chess.com");
      const moveList = resolved.searchParams.get("moveList") || "";
      const moves = tokenizeImportedMoveText(moveList);
      if (moves.length >= 6) {
        candidates.push({
          source: "html-explorer-moveList",
          moves,
        });
      }
    } catch {
      // Ignore malformed explorer links and keep scanning.
    }
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

  return deduped;
}

function importSourceTextFromPayload(payload) {
  const directPgn = typeof payload?.pgn === "string" ? payload.pgn.trim() : "";
  if (directPgn) {
    return directPgn;
  }

  const moveCandidates = Array.isArray(payload?.moveCandidates) ? payload.moveCandidates : [];
  for (const candidate of moveCandidates) {
    if (!Array.isArray(candidate?.moves) || !candidate.moves.length) {
      continue;
    }
    const pgn = buildPgnFromSanMoves(payload.headers ?? {}, candidate.moves);
    try {
      parseImportedGame(pgn);
      return pgn;
    } catch {
      // Try the next candidate.
    }
  }

  if (Array.isArray(payload?.moves) && payload.moves.length) {
    const pgn = buildPgnFromSanMoves(payload.headers ?? {}, payload.moves);
    try {
      parseImportedGame(pgn);
      return pgn;
    } catch {
      // Fall through to importedText if the SAN scrape was noisy.
    }
  }

  const importedText = typeof payload?.importedText === "string" ? payload.importedText.trim() : "";
  if (importedText) {
    const htmlMoveCandidates = extractMoveCandidatesFromImportedHtml(importedText);
    for (const candidate of htmlMoveCandidates) {
      const pgn = buildPgnFromSanMoves(payload.headers ?? {}, candidate.moves);
      try {
        parseImportedGame(pgn);
        return pgn;
      } catch {
        // Keep trying other structured candidates.
      }
    }

    if (/<(?:!doctype\s+html|html)\b/i.test(importedText) && !/"pgn"\s*:\s*"((?:\\.|[^"\\])*)"/i.test(importedText)) {
      throw new Error("Could not extract a playable move list from the Chess.com page.");
    }
    return importedText;
  }

  throw new Error("Import handoff did not include PGN or imported text.");
}

function renderImportPermalink() {
  if (!elements.importPermalink) {
    return;
  }

  if (!app.currentImportedGame) {
    elements.importPermalink.textContent = "Import a game to create a reopenable local link in this browser.";
    return;
  }

  elements.importPermalink.textContent = new URL(
    routePathForRecord(app.currentImportedGame),
    window.location.origin,
  ).toString();
}

function renderImportHistory() {
  if (!elements.importHistory) {
    return;
  }

  if (!app.recentImports.length) {
    elements.importHistory.innerHTML = `
      <p class="import-history-empty">
        Imported games are cached locally here. Reopen them instantly after the first import.
      </p>
    `;
    return;
  }

  const activeKey = currentImportedGameKey();
  elements.importHistory.innerHTML = app.recentImports.map((record) => {
    const metaParts = [
      sourceLabel(record),
      formatImportDate(record.playedAt),
      record.result && record.result !== "*" ? record.result : null,
    ].filter(Boolean);
    const identifier = record.source && record.sourceGameId
      ? `${record.source}:${record.sourceGameId}`
      : (record.pgnHash ?? "");
    const isActive = identifier === activeKey;

    return `
      <button
        type="button"
        class="import-history-item${isActive ? " active" : ""}"
        data-cache-key="${escapeHtml(identifier)}"
      >
        <strong>${escapeHtml(importRecordTitle(record))}</strong>
        <span>${escapeHtml(metaParts.join(" • ") || "Cached review")}</span>
      </button>
    `;
  }).join("");
}

function findCachedRecordByKey(cacheKey) {
  if (!cacheKey) {
    return null;
  }

  const sourceSeparator = cacheKey.indexOf(":");
  if (sourceSeparator > 0) {
    const source = cacheKey.slice(0, sourceSeparator);
    const sourceGameId = cacheKey.slice(sourceSeparator + 1);
    if (source && sourceGameId && source !== "local") {
      return app.gameCache.findBySourceGameId(source, sourceGameId);
    }
  }

  return app.gameCache.findByPgnHash(cacheKey);
}

function pieceAssetUrl(piece) {
  return `${PIECE_IMAGE_BASE_URL}/${piece.color}${piece.type}.png`;
}

function pieceAriaLabel(piece) {
  const color = piece.color === "w" ? "white" : "black";
  const names = {
    k: "king",
    q: "queen",
    r: "rook",
    b: "bishop",
    n: "knight",
    p: "pawn",
  };
  return `${color} ${names[piece.type]}`;
}

function createNode(parentId, state, move = null) {
  const parent = parentId ? app.nodes.get(parentId) : null;
  const node = {
    id: nextNodeId(),
    parentId,
    children: [],
    preferredChildId: null,
    state,
    move,
    label: move && parent ? formatSanMove(parent.state, move) : "Start",
    feedback: null,
    feedbackPending: false,
    analysis: null,
    ply: parent ? parent.ply + 1 : 0,
  };
  app.nodes.set(node.id, node);
  if (parent) {
    parent.children.push(node.id);
    parent.preferredChildId = node.id;
  }
  app.latestNodeId = node.id;
  return node;
}

function getCurrentNode() {
  return app.nodes.get(app.currentNodeId);
}

function getNode(nodeId) {
  return app.nodes.get(nodeId);
}

function getReviewPlayerName(color) {
  if (color === "w") {
    return app.gameHeaders.White || "White";
  }
  return app.gameHeaders.Black || "Black";
}

function importedGameLabel() {
  const whiteName = app.gameHeaders.White || "White";
  const blackName = app.gameHeaders.Black || "Black";
  return `${whiteName} vs ${blackName}`;
}

function parseImportedResult(headers) {
  const score = String(headers.Result ?? "").trim();
  if (!score || score === "*") {
    return null;
  }

  const termination = String(headers.Termination ?? "").trim();
  const lowerTermination = termination.toLowerCase();
  const winner = score === "1-0" ? "w" : score === "0-1" ? "b" : null;

  if (winner) {
    let type = "win";
    if (lowerTermination.includes("checkmat")) {
      type = "checkmate";
    } else if (lowerTermination.includes("resign")) {
      type = "resignation";
    } else if (lowerTermination.includes("time") || lowerTermination.includes("forfeit")) {
      type = "timeout";
    } else if (lowerTermination.includes("abandon")) {
      type = "abandoned";
    }

    return {
      type,
      winner,
      loser: oppositeColor(winner),
      score,
      termination,
    };
  }

  let type = "draw";
  if (lowerTermination.includes("stalemate")) {
    type = "stalemate";
  } else if (lowerTermination.includes("repetition")) {
    type = "repetition";
  } else if (lowerTermination.includes("insufficient")) {
    type = "insufficient-material";
  } else if (lowerTermination.includes("50")) {
    type = "fifty-move";
  } else if (lowerTermination.includes("agreement")) {
    type = "agreed-draw";
  }

  return {
    type,
    winner: null,
    loser: null,
    score,
    termination,
  };
}

function isImportedResultNode(node) {
  return Boolean(app.importedResult && node?.id === app.importedResultNodeId);
}

function getDisplayedResult(node) {
  const boardResult = getGameResult(node.state);
  if (boardResult) {
    return boardResult;
  }
  if (isImportedResultNode(node)) {
    return app.importedResult;
  }
  return null;
}

function resultScoreline(result) {
  if (result?.score) {
    return result.score;
  }
  if (result?.winner === "w") {
    return "1-0";
  }
  if (result?.winner === "b") {
    return "0-1";
  }
  return "1/2-1/2";
}

function resultEvalFillPercent(result) {
  const scoreline = resultScoreline(result);
  if (scoreline === "1-0") {
    return 100;
  }
  if (scoreline === "0-1") {
    return 0;
  }
  return 50;
}

function resultHeadline(result) {
  return result.winner ? `${colorName(result.winner)} wins` : "Draw";
}

function resultDetail(result) {
  const loserName = result.loser ? colorName(result.loser) : null;
  switch (result.type) {
    case "checkmate":
      return `${loserName} lost by checkmate`;
    case "stalemate":
      return "Stalemate";
    case "resignation":
      return `${loserName} resigned`;
    case "timeout":
      return `${loserName} lost on time`;
    case "abandoned":
      return `${loserName} abandoned the game`;
    case "repetition":
      return "Draw by repetition";
    case "insufficient-material":
      return "Draw by insufficient material";
    case "fifty-move":
      return "Draw by the fifty-move rule";
    case "agreed-draw":
      return "Draw by agreement";
    case "draw":
      return "Game drawn";
    default:
      return loserName ? `${loserName} lost` : "Game ended";
  }
}

function resultPillText(result) {
  switch (result.type) {
    case "checkmate":
      return "Checkmate";
    case "stalemate":
      return "Stalemate";
    case "resignation":
      return "Resignation";
    case "timeout":
      return "Out of time";
    case "abandoned":
      return "Game ended";
    case "repetition":
    case "insufficient-material":
    case "fifty-move":
    case "agreed-draw":
      return "Draw";
    default:
      return resultHeadline(result);
  }
}

function resultStatusText(result, node) {
  const headline = resultHeadline(result);
  const detail = resultDetail(result);
  if (isImportedResultNode(node) && !getGameResult(node.state)) {
    return result.winner
      ? `Imported game ended. ${headline}. ${detail}. You can still branch from this final position.`
      : `Imported game ended. ${detail}. You can still branch from this final position.`;
  }
  return result.winner ? `Game over. ${headline}. ${detail}.` : `Game over. ${detail}.`;
}

function getFeedbackPresentation(feedback) {
  return FEEDBACK_PRESENTATIONS[feedback?.tone] ?? FEEDBACK_PRESENTATIONS.good;
}

function feedbackSummaryText(feedback) {
  if (!feedback) {
    return "";
  }
  const presentation = getFeedbackPresentation(feedback);
  return feedback.detail ? `${presentation.label} - ${feedback.detail}` : presentation.label;
}

function buildFeedbackBadgeMarkup(feedback, options = {}) {
  const presentation = options.pending
    ? FEEDBACK_PRESENTATIONS.pending
    : getFeedbackPresentation(feedback);
  const toneClass = options.pending ? "feedback-pending" : `feedback-${feedback.tone}`;
  const iconOnlyClass = options.iconOnly ? "feedback-icon-only" : "";
  const textMarkup = options.iconOnly
    ? ""
    : `<span class="feedback-badge-text">${escapeHtml(presentation.label)}</span>`;
  const title = options.pending ? presentation.label : feedbackSummaryText(feedback);

  return `
    <span class="feedback-badge ${toneClass} ${iconOnlyClass}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
      <span class="feedback-symbol">${escapeHtml(presentation.symbol)}</span>
      ${textMarkup}
    </span>
  `;
}

function formatDelayMs(ms) {
  if (ms <= 0) {
    return "0s";
  }
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

function renderMoveKey() {
  if (!elements.moveKey) {
    return;
  }

  elements.moveKey.innerHTML = MOVE_KEY_ITEMS.map(([tone, detail]) => {
    const feedback = { tone, detail: "" };
    return `
      <div class="move-key-row">
        ${buildFeedbackBadgeMarkup(feedback, { iconOnly: true })}
        <div class="move-key-copy">
          <strong>${escapeHtml(FEEDBACK_PRESENTATIONS[tone].label)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
      </div>
    `;
  }).join("");
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function feedbackAccuracyEstimate(feedback) {
  if (!feedback) {
    return null;
  }
  if (["brilliant", "great", "best"].includes(feedback.tone)) {
    return 100;
  }

  const loss = Math.max(0, feedback.loss ?? 0);
  const base = 100 - (loss / (loss + 400)) * 100;

  switch (feedback.tone) {
    case "excellent":
      return Math.max(95, base);
    case "good":
      return Math.max(88, base);
    case "inaccuracy":
      return clampNumber(base, 72, 82);
    case "mistake":
      return clampNumber(base, 56, 68);
    case "miss":
      return clampNumber(base, 50, 62);
    case "blunder":
      return clampNumber(base, 22, 42);
    default:
      return clampNumber(base, 0, 100);
  }
}

function averageNumbers(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function initialsForName(name, fallback = "?") {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    return fallback;
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatSummaryScore(value, digits = 1) {
  return value == null ? "--" : value.toFixed(digits);
}

function estimatePerformanceRating(playerSummary) {
  if (!playerSummary.moveCount || playerSummary.accuracy == null) {
    return null;
  }

  const counts = playerSummary.counts;
  const estimated = 500
    + playerSummary.accuracy * 13.5
    + counts.brilliant * 35
    + counts.great * 18
    + counts.best * 2
    + playerSummary.moveCount * 1.5
    - counts.inaccuracy * 8
    - counts.mistake * 35
    - counts.miss * 28
    - counts.blunder * 70;

  return Math.round(clampNumber(estimated, 100, 2900) / 10) * 10;
}

function buildReviewSummaryData() {
  if (app.mode !== "review" || app.importedMainlineIds.length < 2) {
    return null;
  }

  const nodes = app.importedMainlineIds
    .map((nodeId) => getNode(nodeId))
    .filter(Boolean);

  if (nodes.length < 2) {
    return null;
  }

  const players = {
    w: {
      color: "w",
      name: getReviewPlayerName("w"),
      moveCount: 0,
      accuracyValues: [],
      counts: Object.fromEntries(Object.keys(FEEDBACK_PRESENTATIONS).map((tone) => [tone, 0])),
    },
    b: {
      color: "b",
      name: getReviewPlayerName("b"),
      moveCount: 0,
      accuracyValues: [],
      counts: Object.fromEntries(Object.keys(FEEDBACK_PRESENTATIONS).map((tone) => [tone, 0])),
    },
  };

  const graphPoints = [];
  nodes.forEach((node, index) => {
    if (node.analysis?.score) {
      graphPoints.push({
        index,
        score: whitePerspectiveScore(node.analysis.score, node.state.turn),
        tone: node.feedback?.tone ?? null,
      });
    }

    if (!index || !node.move || !node.feedback) {
      return;
    }

    const player = players[node.move.color];
    player.moveCount += 1;
    player.accuracyValues.push(feedbackAccuracyEstimate(node.feedback));
    if (node.feedback.tone in player.counts) {
      player.counts[node.feedback.tone] += 1;
    }
  });

  for (const color of ["w", "b"]) {
    players[color].accuracy = averageNumbers(players[color].accuracyValues);
    players[color].gameRating = estimatePerformanceRating(players[color]);
    players[color].initials = initialsForName(players[color].name, color.toUpperCase());
  }

  const lastGraphPoint = graphPoints[graphPoints.length - 1] ?? null;
  const leadClass = !lastGraphPoint
    ? "review-lead-equal"
    : lastGraphPoint.score > 35
      ? "review-lead-white"
      : lastGraphPoint.score < -35
        ? "review-lead-black"
        : "review-lead-equal";

  return {
    players,
    graphPoints,
    leadText: lastGraphPoint ? formatWhitePerspectiveNumeric(lastGraphPoint.score) : "Review building",
    leadClass,
    readyCount: nodes.filter((node, index) => index > 0 && node.feedback).length,
    totalMoves: nodes.length - 1,
  };
}

function buildReviewGraphMarkup(points) {
  if (points.length < 2) {
    return '<div class="review-graph-empty">Not enough analyzed moves yet.</div>';
  }

  const width = 100;
  const height = 26;
  const baseline = 13;
  const padX = 3;
  const padY = 2;

  const coords = points.map((point, index) => {
    const x = padX + (index / Math.max(points.length - 1, 1)) * (width - padX * 2);
    const normalized = Math.tanh(clampNumber(point.score, -1400, 1400) / 320);
    const y = baseline - normalized * (baseline - padY - 1);
    return { ...point, x, y };
  });

  const areaPath = [
    `M ${coords[0].x} ${baseline}`,
    ...coords.map((point) => `L ${point.x} ${point.y}`),
    `L ${coords[coords.length - 1].x} ${baseline}`,
    "Z",
  ].join(" ");

  const linePoints = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const circles = coords.slice(1).map((point) => {
    const toneColor = point.tone ? FEEDBACK_PRESENTATIONS[point.tone]?.color ?? "#83cf51" : "#dadada";
    return `<circle cx="${point.x}" cy="${point.y}" r="0.9" fill="${toneColor}"></circle>`;
  }).join("");

  return `
    <svg class="review-summary-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <line class="review-summary-baseline" x1="${padX}" y1="${baseline}" x2="${width - padX}" y2="${baseline}"></line>
      <path class="review-summary-area" d="${areaPath}"></path>
      <polyline class="review-summary-line" points="${linePoints}"></polyline>
      ${circles}
    </svg>
  `;
}

function renderReviewSummary() {
  if (!elements.reviewSummary) {
    return;
  }

  const summary = buildReviewSummaryData();
  if (!summary) {
    elements.reviewSummary.innerHTML = "";
    elements.reviewSummary.classList.add("hidden");
    return;
  }

  const statRows = REVIEW_SUMMARY_TONES.map((tone) => {
    const presentation = FEEDBACK_PRESENTATIONS[tone];
    return `
      <div class="review-stat-row review-tone-${tone}">
        <span class="review-stat-label">${escapeHtml(presentation.label)}</span>
        <strong class="review-stat-value">${summary.players.w.counts[tone] ?? 0}</strong>
        <span class="review-stat-icon">${buildFeedbackBadgeMarkup({ tone, detail: "" }, { iconOnly: true })}</span>
        <strong class="review-stat-value">${summary.players.b.counts[tone] ?? 0}</strong>
      </div>
    `;
  }).join("");

  elements.reviewSummary.innerHTML = `
    <div class="review-summary-header">
      <span>Game review</span>
      <strong class="${summary.leadClass}">${escapeHtml(summary.leadText)}</strong>
    </div>
    ${buildReviewGraphMarkup(summary.graphPoints)}
    <div class="review-summary-names">
      <span>${escapeHtml(summary.players.w.name)}</span>
      <span>${escapeHtml(summary.players.b.name)}</span>
    </div>
    <div class="review-player-row">
      <span class="review-row-title">Players</span>
      <div class="review-player-card white">
        <span class="review-player-avatar">${escapeHtml(summary.players.w.initials)}</span>
      </div>
      <div class="review-player-card black">
        <span class="review-player-avatar">${escapeHtml(summary.players.b.initials)}</span>
      </div>
    </div>
    <div class="review-score-row">
      <span class="review-row-title">Accuracy</span>
      <strong class="review-score-box white">${escapeHtml(formatSummaryScore(summary.players.w.accuracy))}</strong>
      <strong class="review-score-box black">${escapeHtml(formatSummaryScore(summary.players.b.accuracy))}</strong>
    </div>
    <div class="review-divider"></div>
    <div class="review-stat-table">
      ${statRows}
    </div>
    <div class="review-divider"></div>
    <div class="review-score-row">
      <span class="review-row-title">Game rating</span>
      <strong class="review-score-box white">${summary.players.w.gameRating == null ? "--" : summary.players.w.gameRating}</strong>
      <strong class="review-score-box black">${summary.players.b.gameRating == null ? "--" : summary.players.b.gameRating}</strong>
    </div>
  `;
  elements.reviewSummary.classList.remove("hidden");
}

function cancelPendingEngineReply() {
  if (!app.pendingEngineReply) {
    return;
  }
  window.clearTimeout(app.pendingEngineReply.timerId);
  app.pendingEngineReply = null;
}

function scheduleEngineAutoReply(nodeId, replyMove) {
  cancelPendingEngineReply();

  const delayMs = Math.max(0, app.engineReplyDelayMs);
  const timerId = window.setTimeout(() => {
    const pending = app.pendingEngineReply;
    if (!pending || pending.nodeId !== nodeId || pending.replyUci !== moveToUci(replyMove)) {
      return;
    }

    app.pendingEngineReply = null;

    const liveNode = getNode(nodeId);
    if (!liveNode) {
      renderAll();
      return;
    }

    const replyNode = ensureChildNode(nodeId, replyMove);
    if (!replyNode.analysis || replyNode.analysis.depth !== app.depth) {
      replyNode.analysis = null;
    }

    if (app.currentNodeId === nodeId) {
      setCurrentNode(replyNode.id, { skipEngineWork: true });
    } else {
      renderAll();
    }

    if (app.currentNodeId === replyNode.id) {
      requestAnalysisForNode(replyNode.id);
    }
  }, delayMs);

  app.pendingEngineReply = {
    nodeId,
    replyUci: moveToUci(replyMove),
    timerId,
    readyAt: Date.now() + delayMs,
  };
}

function resetReviewWarmup() {
  app.reviewWarmup.active = false;
  app.reviewWarmup.pending = false;
  app.reviewWarmup.totalMoves = 0;
  app.reviewWarmup.doneMoves = 0;
  app.reviewWarmup.currentNodeId = null;
}

function setImportedMainline(nodeIds) {
  app.importedMainlineIds = [...nodeIds];
  app.importedMainlineSet = new Set(nodeIds);
}

function isImportedMainlineNode(nodeId) {
  return app.importedMainlineSet.has(nodeId);
}

function reviewWarmupMessage() {
  if (!app.importedMainlineIds.length) {
    return null;
  }

  if (app.reviewWarmup.pending) {
    return `Imported ${importedGameLabel()}. Waiting for Stockfish to finish loading before full review starts.`;
  }

  if (app.reviewWarmup.active) {
    return `Imported ${importedGameLabel()}. Analyzing with Stockfish ${app.reviewWarmup.doneMoves}/${app.reviewWarmup.totalMoves} move${app.reviewWarmup.totalMoves === 1 ? "" : "s"}...`;
  }

  if (app.reviewWarmup.totalMoves > 0 && app.reviewWarmup.doneMoves >= app.reviewWarmup.totalMoves) {
    return `Imported ${importedGameLabel()}. Full review is ready.`;
  }

  return `Imported ${importedGameLabel()}.`;
}

function updateReviewWarmupStatus(state = "loading") {
  const message = reviewWarmupMessage();
  if (!message) {
    return;
  }
  setImportStatus(message, state);
}

function activeInputColor(node) {
  if (!node || getGameResult(node.state)) {
    return null;
  }
  if (app.mode === "review") {
    return node.state.turn;
  }
  if (node.state.turn === app.playerColor) {
    return app.playerColor;
  }
  return node.id !== app.latestNodeId ? node.state.turn : null;
}

function ensureChildNode(parentId, move) {
  const parent = getNode(parentId);
  const existingChild = findChildNodeByUci(parentId, moveToUci(move));
  if (existingChild) {
    parent.preferredChildId = existingChild.id;
    return existingChild;
  }
  return createNode(parentId, applyMove(parent.state, move), move);
}

function findChildNodeByUci(parentId, uci) {
  const parent = getNode(parentId);
  for (const childId of parent.children) {
    const child = getNode(childId);
    if (child.move && moveToUci(child.move) === uci) {
      return child;
    }
  }
  return null;
}

function setCurrentNode(nodeId, options = {}) {
  if (!options.keepPendingReply) {
    cancelPendingEngineReply();
  }
  app.currentNodeId = nodeId;
  app.selectedSquare = null;
  clearDragState();
  if (!options.keepPromotion) {
    hidePromotionModal();
  }

  let cursor = getNode(nodeId);
  while (cursor && cursor.parentId) {
    const parent = getNode(cursor.parentId);
    parent.preferredChildId = cursor.id;
    cursor = parent;
  }

  renderAll();

  if (!options.skipEngineWork) {
    ensureEngineWorkForCurrentNode();
  }
}

function resetGame(playerColor, options = {}) {
  nodeCounter = 0;
  app.nodes = new Map();
  app.mode = "play";
  app.playerColor = playerColor;
  app.orientation = playerColor;
  app.selectedSquare = null;
  app.pendingPromotion = null;
  app.gameHeaders = {};
  app.importedResult = null;
  app.importedResultNodeId = null;
  setImportedMainline([]);
  app.dragging = null;
  app.suppressClick = false;
  app.reviewWarmupRunId += 1;
  resetReviewWarmup();
  app.awaitingEngineNodeId = null;
  cancelPendingEngineReply();
  app.engineRequestSerial += 1;
  app.currentImportedGame = null;

  const root = createNode(null, createInitialState(), null);
  app.rootId = root.id;
  app.currentNodeId = root.id;
  app.latestNodeId = root.id;

  if (app.engineReady && app.engine) {
    app.engine.cancelPendingJobs("superseded");
    app.engine.newGame();
  }

  if (options.syncRoute !== false) {
    syncRouteForImportedGame(null);
  }
  setImportStatus("Paste PGN directly, or paste a Chess.com game link and import it here.");
  renderAll();
  ensureEngineWorkForCurrentNode();
}

function ensureEngineWorkForCurrentNode(force = false) {
  if (!app.engineReady || !app.engine) {
    return;
  }

  const node = getCurrentNode();
  if (!node) {
    return;
  }
  const result = getGameResult(node.state);
  if (result) {
    return;
  }

  if (app.mode === "review") {
    if (app.importedMainlineIds.length) {
      if (force && !app.reviewWarmup.active) {
        startReviewWarmup({ immediateNodeId: node.id, resetData: false });
        return;
      }

      if (app.reviewWarmup.active && isImportedMainlineNode(node.id)) {
        return;
      }

      if (
        isImportedMainlineNode(node.id)
        && node.analysis?.depth === app.depth
        && (!node.move || node.feedback)
      ) {
        return;
      }
    }

    if (
      !force
      && node.analysis?.depth === app.depth
      && (!node.move || node.feedback || node.feedbackPending)
    ) {
      return;
    }
    requestReviewDataForNode(node.id);
    return;
  }

  if (activeInputColor(node) === node.state.turn) {
    if (!force && node.analysis && node.analysis.depth === app.depth) {
      return;
    }
    requestAnalysisForNode(node.id);
    return;
  }

  if (node.children.length > 0) {
    return;
  }

  requestEngineReplyForNode(node.id);
}

async function requestAnalysisForNode(nodeId) {
  const node = getNode(nodeId);
  if (!node || !app.engineReady || !app.engine) {
    return null;
  }

  if (node.analysis?.depth === app.depth) {
    return node.analysis;
  }

  const requestSerial = ++app.engineRequestSerial;
  try {
    const analysis = await app.engine.analyze(generateFen(node.state), app.depth);
    if (requestSerial !== app.engineRequestSerial) {
      return;
    }
    const liveNode = getNode(nodeId);
    if (!liveNode) {
      return null;
    }
    liveNode.analysis = analysis;
    if (app.currentNodeId === nodeId) {
      renderAll();
    }
    return analysis;
  } catch (error) {
    if (error.message !== "superseded") {
      elements.engineStatus.textContent = `Analysis stopped: ${error.message}`;
    }
    return null;
  }
}

async function analyzeNodeForWarmup(nodeId, runId) {
  const node = getNode(nodeId);
  if (!node || !app.engineReady || !app.engine) {
    return null;
  }

  if (runId !== app.reviewWarmupRunId) {
    throw new Error("warmup-stale");
  }

  if (node.analysis?.depth === app.depth) {
    return node.analysis;
  }

  const analysis = await app.engine.analyze(generateFen(node.state), app.depth);
  if (runId !== app.reviewWarmupRunId) {
    throw new Error("warmup-stale");
  }

  const liveNode = getNode(nodeId);
  if (!liveNode) {
    throw new Error("warmup-stale");
  }

  liveNode.analysis = analysis;
  if (app.currentNodeId === nodeId) {
    renderAll();
  }
  return analysis;
}

function clearImportedMainlineReviewData() {
  for (const nodeId of app.importedMainlineIds) {
    const node = getNode(nodeId);
    if (!node) {
      continue;
    }
    node.analysis = null;
    node.feedbackPending = false;
    if (node.parentId) {
      node.feedback = null;
    }
  }
}

async function startReviewWarmup(options = {}) {
  if (app.mode !== "review" || !app.importedMainlineIds.length) {
    return;
  }

  const runId = ++app.reviewWarmupRunId;
  if (options.resetData) {
    clearImportedMainlineReviewData();
  }

  app.reviewWarmup.active = false;
  app.reviewWarmup.pending = !app.engineReady || !app.engine;
  app.reviewWarmup.totalMoves = Math.max(app.importedMainlineIds.length - 1, 0);
  app.reviewWarmup.doneMoves = 0;
  app.reviewWarmup.currentNodeId = null;
  updateReviewWarmupStatus("loading");

  if (!app.engineReady || !app.engine) {
    renderAll();
    return;
  }

  app.engine.cancelPendingJobs("superseded");
  app.reviewWarmup.pending = false;
  app.reviewWarmup.active = true;
  updateReviewWarmupStatus("loading");

  const immediateNodeId = options.immediateNodeId ?? app.currentNodeId;
  try {
    if (immediateNodeId && immediateNodeId !== app.rootId) {
      const immediateNode = getNode(immediateNodeId);
      const immediateParent = immediateNode?.parentId ? getNode(immediateNode.parentId) : null;
      if (immediateNode && immediateParent) {
        immediateNode.feedbackPending = true;
        app.reviewWarmup.currentNodeId = immediateNodeId;
        renderAll();

        const immediateBaseline = await analyzeNodeForWarmup(immediateParent.id, runId);
        const immediateAnalysis = await analyzeNodeForWarmup(immediateNodeId, runId);
        if (!immediateBaseline || !immediateAnalysis) {
          throw new Error("warmup-stale");
        }

        immediateNode.feedbackPending = false;
        immediateNode.feedback = buildMoveFeedback(
          immediateBaseline,
          immediateAnalysis,
          immediateNode.move,
          immediateNode.state.turn,
          immediateParent.state,
          immediateNode.state,
          immediateNode.move.color,
        );
        if (app.currentNodeId === immediateNodeId) {
          renderAll();
        }
      }
    }

    const rootId = app.importedMainlineIds[0];
    let baseline = await analyzeNodeForWarmup(rootId, runId);

    for (let index = 1; index < app.importedMainlineIds.length; index += 1) {
      if (runId !== app.reviewWarmupRunId) {
        throw new Error("warmup-stale");
      }

      const nodeId = app.importedMainlineIds[index];
      const node = getNode(nodeId);
      const parent = node?.parentId ? getNode(node.parentId) : null;
      if (!node || !parent) {
        throw new Error("warmup-stale");
      }

      app.reviewWarmup.currentNodeId = nodeId;
      node.feedbackPending = true;
      updateReviewWarmupStatus("loading");
      if (app.currentNodeId === nodeId || app.currentNodeId === parent.id) {
        renderAll();
      }

      const analysis = await analyzeNodeForWarmup(nodeId, runId);
      if (!analysis) {
        throw new Error("warmup-stale");
      }

      node.feedbackPending = false;
      node.feedback = buildMoveFeedback(
        baseline,
        analysis,
        node.move,
        node.state.turn,
        parent.state,
        node.state,
        node.move.color,
      );

      baseline = analysis;
      app.reviewWarmup.doneMoves = index;
      updateReviewWarmupStatus("loading");
      if (app.currentNodeId === nodeId || app.currentNodeId === parent.id) {
        renderAll();
      }
    }

    if (runId !== app.reviewWarmupRunId) {
      throw new Error("warmup-stale");
    }

    app.reviewWarmup.active = false;
    app.reviewWarmup.currentNodeId = null;
    app.reviewWarmup.doneMoves = app.reviewWarmup.totalMoves;
    updateReviewWarmupStatus("success");
    renderAll();
  } catch (error) {
    if (error.message === "warmup-stale" || error.message === "superseded") {
      return;
    }

    app.reviewWarmup.active = false;
    app.reviewWarmup.pending = false;
    app.reviewWarmup.currentNodeId = null;
    setImportStatus(`Imported ${importedGameLabel()}, but Stockfish review stopped: ${error.message}`, "error");
    renderAll();
  }
}

async function requestReviewDataForNode(nodeId) {
  const node = getNode(nodeId);
  if (!node || !app.engineReady || !app.engine) {
    return;
  }

  if (!node.parentId) {
    await requestAnalysisForNode(node.id);
    return;
  }

  const parent = getNode(node.parentId);
  if (!parent) {
    return;
  }

  const baseline = await requestAnalysisForNode(parent.id);
  if (!baseline) {
    return;
  }

  await requestEngineReplyForNode(node.id, baseline, node.move, parent.state, {
    autoReply: false,
    perspectiveColor: node.move.color,
  });
}

async function requestEngineReplyForNode(nodeId, baseline = null, playedMove = null, preMoveState = null, options = {}) {
  const node = getNode(nodeId);
  if (!node || !app.engineReady || !app.engine) {
    return;
  }

  const autoReply = options.autoReply ?? app.mode === "play";
  const perspectiveColor = options.perspectiveColor ?? app.playerColor;

  cancelPendingEngineReply();
  const requestSerial = ++app.engineRequestSerial;
  app.awaitingEngineNodeId = nodeId;
  if (playedMove) {
    node.feedbackPending = true;
  }
  renderAll();

  try {
    const analysis = await app.engine.analyze(generateFen(node.state), app.depth);
    if (requestSerial !== app.engineRequestSerial) {
      const staleNode = getNode(nodeId);
      if (staleNode) {
        staleNode.feedbackPending = false;
      }
      if (app.awaitingEngineNodeId === nodeId) {
        app.awaitingEngineNodeId = null;
      }
      return;
    }

    app.awaitingEngineNodeId = null;
    const liveNode = getNode(nodeId);
    if (!liveNode) {
      return;
    }

    liveNode.analysis = analysis;
    if (playedMove) {
      liveNode.feedbackPending = false;
      liveNode.feedback = buildMoveFeedback(
        baseline,
        analysis,
        playedMove,
        node.state.turn,
        preMoveState,
        liveNode.state,
        perspectiveColor,
      );
    }

    if (!autoReply) {
      renderAll();
      return;
    }

    if (analysis.bestmove === "(none)") {
      renderAll();
      return;
    }

    const legalMoves = generateLegalMoves(liveNode.state);
    const replyMove = legalMoves.find((move) => moveToUci(move) === analysis.bestmove);
    if (!replyMove) {
      renderAll();
      return;
    }

    scheduleEngineAutoReply(nodeId, replyMove);
    renderAll();
  } catch (error) {
    if (requestSerial === app.engineRequestSerial) {
      app.awaitingEngineNodeId = null;
      const liveNode = getNode(nodeId);
      if (liveNode) {
        liveNode.feedbackPending = false;
      }
      if (error.message !== "superseded") {
        elements.engineStatus.textContent = `Engine stopped: ${error.message}`;
        renderAll();
      }
    }
  }
}

function canPlayerMove(node) {
  return Boolean(activeInputColor(node));
}

function legalMovesForInput(node) {
  const inputColor = activeInputColor(node);
  if (!node || !inputColor) {
    return [];
  }
  return generateLegalMoves(node.state, inputColor);
}

function getBoardSquareAtPoint(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return target?.closest(".square") ?? null;
}

function clearDragState() {
  if (!app.dragging) {
    return;
  }
  app.dragging = null;
  renderDragLayer();
}

function suppressImmediateClick() {
  app.suppressClick = true;
  window.setTimeout(() => {
    app.suppressClick = false;
  }, 0);
}

function onBoardPointerDown(event) {
  if (event.button !== 0) {
    return;
  }

  const squareElement = event.target.closest(".square");
  if (!squareElement) {
    return;
  }

  const node = getCurrentNode();
  const inputColor = activeInputColor(node);
  if (!inputColor) {
    return;
  }

  const squareIndex = Number(squareElement.dataset.index);
  const piece = node.state.board[squareIndex];
  if (!piece || piece.color !== inputColor) {
    return;
  }

  event.preventDefault();

  app.dragging = {
    pointerId: event.pointerId,
    fromSquare: squareIndex,
    piece: { ...piece },
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    active: false,
  };
}

function onWindowPointerMove(event) {
  if (!app.dragging || event.pointerId !== app.dragging.pointerId) {
    return;
  }

  app.dragging.currentX = event.clientX;
  app.dragging.currentY = event.clientY;

  if (!app.dragging.active) {
    const movedX = event.clientX - app.dragging.startX;
    const movedY = event.clientY - app.dragging.startY;
    if (Math.hypot(movedX, movedY) < 8) {
      return;
    }

    app.dragging.active = true;
    app.selectedSquare = app.dragging.fromSquare;
    renderBoard();
    return;
  }

  renderDragLayer();
}

function onWindowPointerUp(event) {
  if (!app.dragging || event.pointerId !== app.dragging.pointerId) {
    return;
  }

  const dragging = app.dragging;
  const squareElement = getBoardSquareAtPoint(event.clientX, event.clientY);
  const targetIndex = squareElement ? Number(squareElement.dataset.index) : null;
  const wasActive = dragging.active;
  clearDragState();

  if (!wasActive) {
    return;
  }

  suppressImmediateClick();
  const node = getCurrentNode();
  if (!canPlayerMove(node) || targetIndex == null) {
    renderBoard();
    return;
  }

  const matchingMoves = legalMovesForInput(node).filter((move) => move.from === dragging.fromSquare && move.to === targetIndex);
  if (!matchingMoves.length) {
    renderBoard();
    return;
  }

  if (matchingMoves.length > 1) {
    app.selectedSquare = dragging.fromSquare;
    showPromotionModal(matchingMoves);
    renderBoard();
    return;
  }

  commitPlayerMove(matchingMoves[0]);
}

function onWindowPointerCancel(event) {
  if (!app.dragging || event.pointerId !== app.dragging.pointerId) {
    return;
  }
  clearDragState();
  renderBoard();
}

function onBoardClick(event) {
  if (app.suppressClick) {
    app.suppressClick = false;
    return;
  }

  const squareElement = event.target.closest(".square");
  if (!squareElement) {
    return;
  }

  const node = getCurrentNode();
  if (!canPlayerMove(node)) {
    app.selectedSquare = null;
    renderBoard();
    return;
  }

  const squareIndex = Number(squareElement.dataset.index);
  const state = node.state;
  const piece = state.board[squareIndex];
  const inputColor = activeInputColor(node);
  const legalMoves = legalMovesForInput(node);

  if (app.selectedSquare != null) {
    const matchingMoves = legalMoves.filter((move) => move.from === app.selectedSquare && move.to === squareIndex);
    if (matchingMoves.length) {
      if (matchingMoves.length > 1) {
        showPromotionModal(matchingMoves);
        return;
      }
      commitPlayerMove(matchingMoves[0]);
      return;
    }
  }

  if (piece && piece.color === inputColor) {
    app.selectedSquare = squareIndex;
  } else {
    app.selectedSquare = null;
  }

  renderBoard();
}

function showPromotionModal(moves) {
  app.pendingPromotion = moves;
  const color = moves[0]?.color ?? app.playerColor;
  const html = PROMOTION_TYPES.map((type) => {
    const glyph = PIECE_GLYPHS[`${color}${type}`];
    return `<button type="button" data-promotion="${type}" aria-label="Promote to ${type}">${glyph}</button>`;
  }).join("");
  elements.promotionOptions.innerHTML = html;
  elements.promotionModal.classList.remove("hidden");
}

function hidePromotionModal() {
  app.pendingPromotion = null;
  elements.promotionModal.classList.add("hidden");
  elements.promotionOptions.innerHTML = "";
}

function commitPlayerMove(move) {
  const currentNode = getCurrentNode();
  const baseline = currentNode.analysis;
  const existingChild = findChildNodeByUci(currentNode.id, moveToUci(move));
  if (existingChild) {
    setCurrentNode(existingChild.id);
    return;
  }

  const childNode = ensureChildNode(currentNode.id, move);

  childNode.feedbackPending = true;
  childNode.feedback = null;
  childNode.analysis = null;
  app.selectedSquare = null;

  setCurrentNode(childNode.id, { skipEngineWork: true });

  const manualOpponentMove = app.mode === "play" && move.color !== app.playerColor;

  const result = getGameResult(childNode.state);
  if (result) {
    childNode.feedbackPending = false;
    if (baseline && baseline.bestmove === moveToUci(move)) {
      childNode.feedback = {
        tone: "best",
        label: "Best move",
        detail: resultDetail(result),
        loss: 0,
      };
    }
    renderAll();
    return;
  }

  requestEngineReplyForNode(
    childNode.id,
    baseline,
    move,
    currentNode.state,
    app.mode === "review" || manualOpponentMove
      ? { autoReply: false, perspectiveColor: move.color }
      : undefined,
  );
}

function renderAll() {
  renderBoard();
  renderReviewSummary();
  renderMoveTree();
  renderBranchList();
  renderStatus();
  renderDragLayer();
  renderImportPermalink();
  renderImportHistory();
}

function renderBoard() {
  const node = getCurrentNode();
  const state = node.state;
  const displayedResult = getDisplayedResult(node);
  const legalMoves = legalMovesForInput(node);
  const selectedMoves = app.selectedSquare == null ? [] : legalMoves.filter((move) => move.from === app.selectedSquare);
  const targetMap = new Map(selectedMoves.map((move) => [move.to, move]));
  const boardFeedbackNode = getBoardFeedbackNode(node);
  const draggingFrom = app.dragging?.active ? app.dragging.fromSquare : null;
  const defeatedKingSquare = displayedResult?.loser ? findKing(state, displayedResult.loser) : null;
  const ranks = app.orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = app.orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const squares = [];
  for (const rank of ranks) {
    for (const file of files) {
      const index = coordsToIndex(file, rank);
      const piece = state.board[index];
      const isSelected = app.selectedSquare === index;
      const targetMove = targetMap.get(index);
      const classes = [
        "square",
        (file + rank) % 2 === 0 ? "light" : "dark",
        canPlayerMove(node) ? "selectable" : "",
        isSelected ? "selected" : "",
        targetMove ? (targetMove.capture ? "capture" : "target") : "",
        defeatedKingSquare === index ? "defeat-square" : "",
      ].filter(Boolean);

      const fileLabel = rank === ranks[ranks.length - 1] ? `<span class="coord file">${FILES[file]}</span>` : "";
      const rankLabel = file === files[0] ? `<span class="coord rank">${8 - rank}</span>` : "";
      const pieceMarkup = piece
        ? buildPieceMarkup(piece, {
            hidden: draggingFrom === index,
            defeated: defeatedKingSquare === index && piece.type === "k",
          })
        : "";
      const feedbackMarkup = boardFeedbackNode && boardFeedbackNode.move.to === index
        ? buildBoardFeedbackMarkup(boardFeedbackNode)
        : "";

      squares.push(
        `<button type="button" class="${classes.join(" ")}" data-index="${index}" aria-label="${squareName(index)}">${feedbackMarkup}${pieceMarkup}${fileLabel}${rankLabel}</button>`,
      );
    }
  }

  elements.board.innerHTML = squares.join("");
  renderBoardOverlay(boardFeedbackNode);
  renderEndOverlay(displayedResult);
}

function renderStatus() {
  const node = getCurrentNode();
  const result = getDisplayedResult(node);
  const nearestFeedback = findLatestFeedback(node);
  const analysis = node.analysis;
  const awaitingHere = app.awaitingEngineNodeId === node.id;
  const queuedReply = app.pendingEngineReply?.nodeId === node.id ? app.pendingEngineReply : null;

  elements.fenOutput.textContent = generateFen(node.state);
  elements.scoreValue.textContent = result
    ? resultScoreline(result)
    : analysis
      ? formatScore(analysis.score, node.state.turn, app.playerColor)
      : "--";
  elements.evalBarFill.style.height = `${result ? resultEvalFillPercent(result) : evalFillPercent(analysis?.score, node.state.turn)}%`;

  const suggestion = result
    ? "Game ended"
    : analysis?.bestmove && analysis.bestmove !== "(none)"
    ? describeBestMove(node.state, analysis.bestmove)
    : "--";
  elements.bestMove.textContent = suggestion;

  if (nearestFeedback?.feedbackPending) {
    elements.lastFeedback.textContent = "Grading move...";
  } else if (nearestFeedback?.feedback) {
    elements.lastFeedback.textContent = feedbackSummaryText(nearestFeedback.feedback);
  } else {
    elements.lastFeedback.textContent = "Waiting for the first move";
  }

  if (result) {
    elements.turnPill.textContent = resultPillText(result);
    elements.statusText.textContent = resultStatusText(result, node);
    return;
  }

  if (app.mode === "review") {
    const whiteName = app.gameHeaders.White || "White";
    const blackName = app.gameHeaders.Black || "Black";
    if (app.reviewWarmup.active || app.reviewWarmup.pending) {
      elements.turnPill.textContent = app.reviewWarmup.pending
        ? "Waiting for Stockfish"
        : `Building review ${app.reviewWarmup.doneMoves}/${app.reviewWarmup.totalMoves}`;
      elements.statusText.textContent = node.move
        ? `Reviewing ${whiteName} vs ${blackName}. Stockfish is filling the imported game in the background while you browse or branch.`
        : `Imported ${whiteName} vs ${blackName}. Stockfish is preparing the full move-by-move review.`;
      return;
    }

    elements.turnPill.textContent = awaitingHere ? "Reviewing and analyzing" : "Review mode";
    elements.statusText.textContent = node.move
      ? `Reviewing ${whiteName} vs ${blackName}. Use the arrows to step through the game, or move a piece here to branch.`
      : `Imported ${whiteName} vs ${blackName}. Step forward through the game, or branch from any position.`;
    return;
  }

  if (node.state.turn === app.playerColor) {
    elements.turnPill.textContent = node.id === app.latestNodeId ? "Your move" : "Your move from a branch";
    elements.statusText.textContent = node.id === app.latestNodeId
      ? "Play your move or rewind and explore another idea."
      : "You rewound to an earlier position. Any move here will create or follow a branch.";
    return;
  }

  if (node.id !== app.latestNodeId) {
    const sideName = colorName(node.state.turn);
    elements.turnPill.textContent = `${sideName} to move`;
    elements.statusText.textContent = node.children.length > 0
      ? `You rewound before the saved ${sideName.toLowerCase()} reply. Play a different ${sideName.toLowerCase()} move to branch, or use forward to follow the saved line.`
      : `Play any ${sideName.toLowerCase()} move here to branch from this position.`;
    return;
  }

  if (queuedReply) {
    elements.turnPill.textContent = "Stockfish waiting";
    elements.statusText.textContent = `Best reply is shown above. Stockfish will play after ${formatDelayMs(app.engineReplyDelayMs)} unless you rewind or branch first.`;
    return;
  }

  elements.turnPill.textContent = awaitingHere ? "Stockfish thinking" : "Stockfish to move";
  if (node.children.length > 0) {
    elements.statusText.textContent = "This position already has an engine continuation. Use forward to follow it, or go back and branch.";
  } else {
    elements.statusText.textContent = awaitingHere
      ? "Stockfish is evaluating your move and preparing a reply."
      : "Stockfish is ready to continue this branch.";
  }
}

function renderMoveTree() {
  const rows = [];
  collectTreeRows(app.rootId, rows);
  const branchCount = Array.from(app.nodes.values()).filter((node) => node.children.length > 1).length;
  elements.treeSummary.textContent = `${Math.max(app.nodes.size - 1, 0)} moves, ${branchCount} branch${branchCount === 1 ? "" : "es"}`;

  if (!rows.length) {
    elements.moveTree.innerHTML = "<p>No moves yet.</p>";
    return;
  }

  elements.moveTree.innerHTML = rows.map(({ node, treePrefix }) => {
    const currentClass = node.id === app.currentNodeId ? "current" : "";
    const prefix = node.move.color === "w" ? `${Math.ceil(node.ply / 2)}.` : `${Math.ceil(node.ply / 2)}...`;
    const role = app.mode === "review"
      ? getReviewPlayerName(node.move.color)
      : `${colorName(node.move.color)} move`;
    const feedbackBadge = node.feedback
      ? buildFeedbackBadgeMarkup(node.feedback)
      : node.feedbackPending
        ? buildFeedbackBadgeMarkup(null, { pending: true })
        : "";
    const meta = [
      role,
      node.feedback?.detail,
      node.analysis?.score ? `Eval ${formatScore(node.analysis.score, node.state.turn, app.playerColor)}` : "",
    ].filter(Boolean);

    return `
      <button type="button" class="tree-row ${currentClass}" data-node-id="${node.id}">
        <div class="tree-row-body">
          <div class="tree-row-main">
            <div class="tree-move-line">
              <code class="tree-prefix" aria-hidden="true">${escapeHtml(treePrefix)}</code>
              <strong>${prefix} ${escapeHtml(node.label)}</strong>
            </div>
            ${feedbackBadge}
          </div>
          <div class="tree-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        </div>
      </button>
    `;
  }).join("");
}

function collectTreeRows(nodeId, output, ancestorHasNext = []) {
  const node = getNode(nodeId);
  node.children.forEach((childId, index) => {
    const child = getNode(childId);
    const isLast = index === node.children.length - 1;
    const treePrefix = [
      ...ancestorHasNext.map((hasNext) => (hasNext ? "│  " : "   ")),
      isLast ? "└─ " : "├─ ",
    ].join("");
    output.push({ node: child, treePrefix });
    collectTreeRows(child.id, output, [...ancestorHasNext, !isLast]);
  });
}

function renderBranchList() {
  const current = getCurrentNode();
  let title = "Current line";
  let items = [];

  if (current.children.length) {
    title = "Continuations";
    items = current.children.map((childId) => getNode(childId));
  } else if (current.parentId) {
    const parent = getNode(current.parentId);
    if (parent.children.length > 1) {
      title = "Alternative branches";
      items = parent.children.map((childId) => getNode(childId));
    }
  }

  elements.branchSummary.textContent = title;

  if (!items.length) {
    elements.branchList.innerHTML = "<p>No saved branches from here yet.</p>";
    return;
  }

  elements.branchList.innerHTML = items.map((node) => {
    const currentLabel = node.id === app.currentNodeId ? "Current" : "Open";
    const role = app.mode === "review"
      ? `${getReviewPlayerName(node.move.color)} move`
      : `${colorName(node.move.color)} move`;
    const feedbackBadge = node.feedback
      ? buildFeedbackBadgeMarkup(node.feedback)
      : node.feedbackPending
        ? buildFeedbackBadgeMarkup(null, { pending: true })
        : "";
    const extra = node.feedback?.detail
      ?? (node.analysis?.score ? `Eval ${formatScore(node.analysis.score, node.state.turn, app.playerColor)}` : "No cached eval");

    return `
      <button type="button" class="branch-card" data-node-id="${node.id}">
        <div class="branch-card-top">
          <strong>${escapeHtml(node.label)}</strong>
          <span>${currentLabel}</span>
        </div>
        ${feedbackBadge ? `<div class="branch-card-badge">${feedbackBadge}</div>` : ""}
        <div class="branch-meta">
          <span>${escapeHtml(role)}</span>
          <span>${escapeHtml(extra)}</span>
        </div>
      </button>
    `;
  }).join("");
}

function findLatestFeedback(node) {
  let cursor = node;
  while (cursor) {
    if (cursor.feedback || cursor.feedbackPending) {
      return cursor;
    }
    cursor = cursor.parentId ? getNode(cursor.parentId) : null;
  }
  return null;
}

function getBoardFeedbackNode(node) {
  const feedbackNode = findLatestFeedback(node);
  if (!feedbackNode || !feedbackNode.move) {
    return null;
  }
  return feedbackNode;
}

function renderBoardOverlay(feedbackNode) {
  if (!elements.boardOverlay) {
    return;
  }

  if (!app.showBestArrow || !feedbackNode?.feedback?.bestUci) {
    elements.boardOverlay.innerHTML = bestArrowDefs();
    return;
  }

  const playedUci = feedbackNode.move ? moveToUci(feedbackNode.move) : null;
  if (!playedUci || playedUci === feedbackNode.feedback.bestUci) {
    elements.boardOverlay.innerHTML = bestArrowDefs();
    return;
  }

  const bestMove = parseUciMove(feedbackNode.feedback.bestUci);
  if (!bestMove) {
    elements.boardOverlay.innerHTML = bestArrowDefs();
    return;
  }

  const { start, end } = bestArrowSegmentForMove(bestMove.from, bestMove.to);
  elements.boardOverlay.innerHTML = `
    ${bestArrowDefs()}
    <line
      class="best-move-arrow"
      x1="${start.x}"
      y1="${start.y}"
      x2="${end.x}"
      y2="${end.y}"
      marker-end="url(#best-arrow-head)"
    ></line>
  `;
}

function bestArrowDefs() {
  return `
    <defs>
      <marker
        id="best-arrow-head"
        viewBox="0 0 10 10"
        markerWidth="0.54"
        markerHeight="0.54"
        refX="10"
        refY="5"
        orient="auto"
      >
        <path d="M0,0 L10,5 L0,10 Z"></path>
      </marker>
    </defs>
  `;
}

function bestArrowSegmentForMove(fromSquare, toSquare) {
  return {
    start: overlayPointForSquare(fromSquare),
    end: overlayPointForSquare(toSquare),
  };
}

function renderEndOverlay(result) {
  if (!elements.endOverlay) {
    return;
  }

  if (!result) {
    elements.endOverlay.innerHTML = "";
    elements.endOverlay.classList.add("hidden");
    return;
  }

  const toneClass = result.winner ? "result-win" : "result-draw";
  elements.endOverlay.innerHTML = `
    <div class="end-banner ${toneClass}">
      <strong>${escapeHtml(resultHeadline(result))}</strong>
      <span>${escapeHtml(resultDetail(result))}</span>
    </div>
  `;
  elements.endOverlay.classList.remove("hidden");
}

function overlayPointForSquare(index) {
  const { file, rank } = indexToCoords(index);
  const x = app.orientation === "w" ? file + 0.5 : 7 - file + 0.5;
  const y = app.orientation === "w" ? rank + 0.5 : 7 - rank + 0.5;
  return { x, y };
}

function renderDragLayer() {
  if (!elements.dragLayer) {
    return;
  }

  if (!app.dragging?.active || !elements.boardStage) {
    elements.dragLayer.innerHTML = "";
    return;
  }

  const rect = elements.boardStage.getBoundingClientRect();
  const x = app.dragging.currentX - rect.left;
  const y = app.dragging.currentY - rect.top;
  elements.dragLayer.innerHTML = `
    <div class="drag-piece" style="left:${x}px; top:${y}px;">
      ${buildPieceMarkup(app.dragging.piece, { dragging: true })}
    </div>
  `;
}

function buildPieceMarkup(piece, options = {}) {
  const glyph = PIECE_GLYPHS[`${piece.color}${piece.type}`];
  const alt = pieceAriaLabel(piece);
  const classes = [
    "piece",
    piece.color,
    options.hidden ? "piece-hidden" : "",
    options.defeated ? "piece-defeated" : "",
  ].filter(Boolean).join(" ");
  return `
    <span class="${classes}" role="img" aria-label="${alt}">
      <img
        class="piece-img"
        src="${pieceAssetUrl(piece)}"
        alt=""
        loading="eager"
        decoding="async"
        draggable="false"
        onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';"
      >
      <span class="piece-fallback ${piece.color}" style="display:none;">${glyph}</span>
    </span>
  `;
}

function buildBoardFeedbackMarkup(node) {
  if (node.feedbackPending) {
    return `<span class="move-callout feedback-pending" title="${escapeHtml(FEEDBACK_PRESENTATIONS.pending.label)}" aria-label="${escapeHtml(FEEDBACK_PRESENTATIONS.pending.label)}">${escapeHtml(FEEDBACK_PRESENTATIONS.pending.symbol)}</span>`;
  }

  if (!node.feedback) {
    return "";
  }

  const presentation = getFeedbackPresentation(node.feedback);
  const summary = feedbackSummaryText(node.feedback);
  return `<span class="move-callout feedback-${node.feedback.tone}" title="${escapeHtml(summary)}" aria-label="${escapeHtml(summary)}">${escapeHtml(presentation.symbol)}</span>`;
}

function describeBestMove(state, uci) {
  const legalMoves = generateLegalMoves(state);
  const move = legalMoves.find((item) => moveToUci(item) === uci);
  return move ? formatSanMove(state, move, legalMoves) : uci;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setImportStatus(message, state = "idle") {
  if (!elements.importStatus) {
    return;
  }
  elements.importStatus.textContent = message;
  elements.importStatus.dataset.state = state;
}

function setImportBusy(busy) {
  app.importBusy = busy;
  if (elements.importButton) {
    elements.importButton.disabled = busy;
  }
}

function importStoredGameRecord(gameRecord, options = {}) {
  const refreshedRecord = options.touch === false ? gameRecord : app.gameCache.save(gameRecord);
  refreshImportHistory();
  const parsed = parseImportedGame(refreshedRecord.pgn);
  importParsedGame(parsed, {
    storedGame: refreshedRecord,
    viewerColor: refreshedRecord.viewerColor ?? null,
    syncRoute: options.syncRoute !== false,
  });
}

function loadCachedGameFromRoute() {
  const route = parseGameRoute(window.location.pathname);
  if (!route) {
    return false;
  }

  const cachedRecord = route.source && route.sourceGameId
    ? app.gameCache.findBySourceGameId(route.source, route.sourceGameId)
    : app.gameCache.findByPgnHash(route.pgnHash);

  if (!cachedRecord) {
    setImportStatus(
      "That local review link is not cached in this browser yet. Import the game once to create it here.",
      "error",
    );
    return false;
  }

  importStoredGameRecord(cachedRecord, { syncRoute: false });
  updateReviewWarmupStatus("loading");
  return true;
}

async function loadImportedRecordFromRoute() {
  const route = parseImportTokenRoute(window.location.pathname);
  if (!route?.token) {
    return false;
  }

  console.info("Loading extension import route", { token: route.token });
  setImportBusy(true);
  setImportStatus("Receiving game from extension...", "loading");

  try {
    const payload = await fetchImportedRecordFromToken(route.token);
    console.info("Fetched extension import payload", {
      sourceGameId: payload?.sourceGameId,
      hasPgn: Boolean(payload?.pgn),
      extraction: payload?.extraction,
    });
    const parsedRecord = parseImportedGame(importSourceTextFromPayload(payload));
    const importedGameRecord = buildNormalizedGameRecord(parsedRecord, {
      source: payload.source ?? null,
      sourceGameId: payload.sourceGameId ?? null,
      sourceUrl: payload.sourceUrl ?? null,
      viewerUsername: payload.viewerUsername ?? null,
    });
    importParsedGame(parsedRecord, {
      storedGame: importedGameRecord,
      viewerColor: importedGameRecord.viewerColor ?? null,
      syncRoute: false,
    });
    if (app.mode !== "review" || app.importedMainlineIds.length < 2) {
      throw new Error("Imported game did not enter review mode.");
    }
    let cachedRecord = null;
    try {
      cachedRecord = finalizeImportedGameCache(importedGameRecord);
    } catch (cacheError) {
      console.warn("Imported game loaded, but local cache finalization failed.", cacheError);
    }
    console.info("Extension import loaded into review mode", {
      sourceGameId: cachedRecord?.sourceGameId ?? payload?.sourceGameId ?? null,
      white: cachedRecord?.whiteUsername ?? parsedRecord.headers.White ?? null,
      black: cachedRecord?.blackUsername ?? parsedRecord.headers.Black ?? null,
      moves: app.importedMainlineIds.length - 1,
    });
    setImportStatus(
      `Imported ${importRecordTitle(cachedRecord ?? { headers: parsedRecord.headers })} from extension.`,
      "success",
    );
    updateReviewWarmupStatus("loading");
    return true;
  } catch (error) {
    console.error("Could not load extension import.", error);
    if (elements.engineStatus) {
      elements.engineStatus.textContent = `Import failed: ${error.message}`;
    }
    if (elements.statusText) {
      elements.statusText.textContent = `Extension import failed: ${error.message}`;
    }
    setImportStatus(error.message || "Could not load the extension import.", "error");
    return false;
  } finally {
    setImportBusy(false);
  }
}

function importParsedGame(record, options = {}) {
  nodeCounter = 0;
  app.nodes = new Map();
  app.mode = "review";
  app.selectedSquare = null;
  app.pendingPromotion = null;
  app.awaitingEngineNodeId = null;
  cancelPendingEngineReply();
  app.reviewWarmupRunId += 1;
  resetReviewWarmup();
  app.engineRequestSerial += 1;
  app.gameHeaders = record.headers;
  app.importedResult = parseImportedResult(record.headers);
  app.importedResultNodeId = null;
  app.currentImportedGame = options.storedGame ?? null;
  clearDragState();

  const viewerColor = options.viewerColor === "w" || options.viewerColor === "b"
    ? options.viewerColor
    : (options.storedGame?.viewerColor === "w" || options.storedGame?.viewerColor === "b"
      ? options.storedGame.viewerColor
      : null);
  if (viewerColor) {
    app.playerColor = viewerColor;
  }
  app.orientation = viewerColor ?? app.playerColor;
  if (elements.playerColor) {
    elements.playerColor.value = app.playerColor;
  }

  if (app.engineReady && app.engine) {
    app.engine.cancelPendingJobs("superseded");
    app.engine.newGame();
  }

  const root = createNode(null, cloneState(record.initialState), null);
  app.rootId = root.id;
  app.currentNodeId = root.id;
  app.latestNodeId = root.id;

  let cursor = root;
  const lineIds = [root.id];
  for (const entry of record.moves) {
    const child = createNode(cursor.id, applyMove(cursor.state, entry.move), entry.move);
    child.label = entry.san;
    cursor = child;
    lineIds.push(child.id);
  }

  setImportedMainline(lineIds);
  app.importedResultNodeId = cursor.id;
  app.currentNodeId = cursor.id;
  app.latestNodeId = cursor.id;
  if (options.syncRoute !== false) {
    syncRouteForImportedGame(app.currentImportedGame);
  }
  renderAll();
  startReviewWarmup({ immediateNodeId: cursor.id, resetData: true });
}

async function importGameForReview() {
  if (app.importBusy) {
    return;
  }

  const pastedText = elements.importPgn?.value.trim() ?? "";
  const importUrl = elements.importUrl?.value.trim() ?? "";
  if (!pastedText && !importUrl) {
    setImportStatus("Paste PGN text or a Chess.com game link first.", "error");
    return;
  }

  setImportBusy(true);
  setImportStatus("Loading game for review...", "loading");

  try {
    const directRef = !pastedText ? extractChessComGameRef(importUrl) : null;
    if (directRef?.sourceGameId) {
      const cachedBySource = app.gameCache.findBySourceGameId(directRef.source, directRef.sourceGameId);
      if (cachedBySource) {
        importStoredGameRecord(cachedBySource);
        updateReviewWarmupStatus("loading");
        return;
      }
    }

    const importedText = pastedText || await fetchImportedTextFromUrl(importUrl);
    const parsedRecord = parseImportedGame(importedText);
    importParsedGame(parsedRecord, { syncRoute: false });
    try {
      finalizeImportedGameCache(parsedRecord, {
        source: directRef?.source ?? null,
        sourceGameId: directRef?.sourceGameId ?? null,
        sourceUrl: directRef?.sourceUrl ?? (importUrl || null),
      });
    } catch (cacheError) {
      console.warn("Imported game loaded, but local cache finalization failed.", cacheError);
    }
    updateReviewWarmupStatus("loading");
  } catch (error) {
    setImportStatus(error.message || "Could not import that game.", "error");
  } finally {
    setImportBusy(false);
  }
}

function navigateFirst() {
  setCurrentNode(app.rootId);
}

function navigateBack() {
  const current = getCurrentNode();
  if (current.parentId) {
    setCurrentNode(current.parentId);
  }
}

function navigateForward() {
  const current = getCurrentNode();
  const nextId = current.preferredChildId ?? current.children[0];
  if (nextId) {
    setCurrentNode(nextId);
  }
}

function navigateLatest() {
  setCurrentNode(app.latestNodeId);
}

function bindEvents() {
  elements.board.addEventListener("pointerdown", onBoardPointerDown);
  elements.board.addEventListener("click", onBoardClick);
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerCancel);

  elements.moveTree.addEventListener("click", (event) => {
    const button = event.target.closest("[data-node-id]");
    if (!button) {
      return;
    }
    setCurrentNode(button.dataset.nodeId);
  });

  elements.branchList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-node-id]");
    if (!button) {
      return;
    }
    setCurrentNode(button.dataset.nodeId);
  });

  elements.importHistory?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cache-key]");
    if (!button) {
      return;
    }
    const cachedRecord = findCachedRecordByKey(button.dataset.cacheKey);
    if (!cachedRecord) {
      setImportStatus("That cached review is no longer available.", "error");
      refreshImportHistory();
      renderAll();
      return;
    }
    importStoredGameRecord(cachedRecord);
    updateReviewWarmupStatus("loading");
  });

  elements.promotionOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-promotion]");
    if (!button || !app.pendingPromotion) {
      return;
    }
    const selectedType = button.dataset.promotion;
    const move = app.pendingPromotion.find((candidate) => candidate.promotion === selectedType);
    hidePromotionModal();
    if (move) {
      commitPlayerMove(move);
    }
  });

  elements.playerColor.addEventListener("change", () => {
    resetGame(elements.playerColor.value);
  });

  elements.showBestArrow.addEventListener("change", () => {
    app.showBestArrow = elements.showBestArrow.checked;
    renderBoard();
  });

  elements.depthInput.addEventListener("input", () => {
    app.depth = Number(elements.depthInput.value);
    elements.depthValue.textContent = String(app.depth);
    if (app.mode === "review" && app.importedMainlineIds.length) {
      startReviewWarmup({ immediateNodeId: app.currentNodeId, resetData: true });
      return;
    }
    ensureEngineWorkForCurrentNode(true);
  });

  elements.replyDelayInput.addEventListener("input", () => {
    app.engineReplyDelayMs = Number(elements.replyDelayInput.value) * 1000;
    elements.replyDelayValue.textContent = formatDelayMs(app.engineReplyDelayMs);

    if (!app.pendingEngineReply) {
      return;
    }

    const pending = app.pendingEngineReply;
    const liveNode = getNode(pending.nodeId);
    if (!liveNode) {
      cancelPendingEngineReply();
      renderAll();
      return;
    }

    const legalMoves = generateLegalMoves(liveNode.state);
    const replyMove = legalMoves.find((move) => moveToUci(move) === pending.replyUci);
    if (!replyMove) {
      cancelPendingEngineReply();
      renderAll();
      return;
    }

    scheduleEngineAutoReply(pending.nodeId, replyMove);
    renderAll();
  });

  elements.newGame.addEventListener("click", () => {
    resetGame(app.playerColor);
  });

  elements.importButton?.addEventListener("click", importGameForReview);
  elements.importUrl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      importGameForReview();
    }
  });
  elements.importPgn?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      importGameForReview();
    }
  });

  elements.firstBtn.addEventListener("click", navigateFirst);
  elements.backBtn.addEventListener("click", navigateBack);
  elements.forwardBtn.addEventListener("click", navigateForward);
  elements.latestBtn.addEventListener("click", navigateLatest);

  elements.flipBtn.addEventListener("click", () => {
    app.orientation = app.orientation === "w" ? "b" : "w";
    renderBoard();
  });

  window.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigateBack();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      navigateForward();
    }
  });
}

async function initEngine() {
  app.engine = new StockfishBridge((message) => {
    elements.engineStatus.textContent = message;
  });

  try {
    await app.engine.init();
    app.engineReady = true;
    elements.engineStatus.textContent = "Stockfish ready";
    if (app.mode === "review" && app.importedMainlineIds.length) {
      startReviewWarmup({ immediateNodeId: app.currentNodeId, resetData: true });
    } else {
      ensureEngineWorkForCurrentNode(true);
    }
  } catch (error) {
    app.engineReady = false;
    console.error(error);
    elements.engineStatus.textContent = `Stockfish unavailable: ${error.message}`;
    renderAll();
  }
}

async function bootstrap() {
  bindEvents();
  elements.playerColor.value = app.playerColor;
  elements.depthValue.textContent = String(app.depth);
  elements.replyDelayValue.textContent = formatDelayMs(app.engineReplyDelayMs);
  elements.showBestArrow.checked = app.showBestArrow;
  renderMoveKey();
  refreshImportHistory();
  resetGame(app.playerColor, { syncRoute: false });
  const loadedFromImportRoute = await loadImportedRecordFromRoute();
  if (!loadedFromImportRoute) {
    loadCachedGameFromRoute();
  }
  await initEngine();
}

bootstrap().catch((error) => {
  console.error(error);
  elements.engineStatus.textContent = `Startup failed: ${error.message}`;
  renderAll();
});

window.addEventListener("error", (event) => {
  const message = event.error?.message || event.message || "Unknown startup error.";
  console.error("Window error", event.error || event.message || event);
  if (elements.engineStatus) {
    elements.engineStatus.textContent = `Runtime error: ${message}`;
  }
  if (elements.statusText) {
    elements.statusText.textContent = `Runtime error: ${message}`;
  }
});
