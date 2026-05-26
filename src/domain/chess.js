export const FILES = "abcdefgh";

export const PIECE_GLYPHS = {
  wk: "♔",
  wq: "♕",
  wr: "♖",
  wb: "♗",
  wn: "♘",
  wp: "♙",
  bk: "♚",
  bq: "♛",
  br: "♜",
  bb: "♝",
  bn: "♞",
  bp: "♟",
};

export const PROMOTION_TYPES = ["q", "r", "b", "n"];

export const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3.15,
  r: 5,
  q: 9,
  k: 0,
};

export const COLOR_NAMES = {
  w: "White",
  b: "Black",
};

export function createInitialState() {
  const board = Array(64).fill(null);
  const backRank = ["r", "n", "b", "q", "k", "b", "n", "r"];

  for (let file = 0; file < 8; file += 1) {
    board[coordsToIndex(file, 0)] = { color: "b", type: backRank[file] };
    board[coordsToIndex(file, 1)] = { color: "b", type: "p" };
    board[coordsToIndex(file, 6)] = { color: "w", type: "p" };
    board[coordsToIndex(file, 7)] = { color: "w", type: backRank[file] };
  }

  return {
    board,
    turn: "w",
    castling: {
      wK: true,
      wQ: true,
      bK: true,
      bQ: true,
    },
    epSquare: null,
    halfmove: 0,
    fullmove: 1,
  };
}

export function cloneState(state) {
  return {
    board: state.board.map((piece) => (piece ? { ...piece } : null)),
    turn: state.turn,
    castling: { ...state.castling },
    epSquare: state.epSquare,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
  };
}

export function coordsToIndex(file, rank) {
  return rank * 8 + file;
}

export function indexToCoords(index) {
  return { file: index % 8, rank: Math.floor(index / 8) };
}

export function squareName(index) {
  const { file, rank } = indexToCoords(index);
  return `${FILES[file]}${8 - rank}`;
}

export function parseSquare(name) {
  if (!name || name.length !== 2) {
    return null;
  }
  const file = FILES.indexOf(name[0]);
  const rank = 8 - Number(name[1]);
  if (file < 0 || rank < 0 || rank > 7) {
    return null;
  }
  return coordsToIndex(file, rank);
}

export function isOnBoard(file, rank) {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

export function oppositeColor(color) {
  return color === "w" ? "b" : "w";
}

export function colorName(color) {
  return COLOR_NAMES[color] ?? "Unknown";
}

export function moveToUci(move) {
  return `${squareName(move.from)}${squareName(move.to)}${move.promotion ?? ""}`;
}

export function formatSanMove(state, move, legalMoves = null) {
  if (move.isCastle) {
    return withSanSuffix(state, move, move.to > move.from ? "O-O" : "O-O-O");
  }

  const pieceLetter = move.piece.type === "p" ? "" : move.piece.type.toUpperCase();
  const moveSet = legalMoves ?? generateLegalMoves(state, move.color);
  let disambiguation = "";

  if (move.piece.type === "p") {
    if (move.capture) {
      disambiguation = FILES[indexToCoords(move.from).file];
    }
  } else {
    const conflicts = moveSet.filter((candidate) => (
      candidate.from !== move.from
      && candidate.to === move.to
      && candidate.piece.type === move.piece.type
      && candidate.color === move.color
    ));

    if (conflicts.length) {
      const origin = indexToCoords(move.from);
      const sharesFile = conflicts.some((candidate) => indexToCoords(candidate.from).file === origin.file);
      const sharesRank = conflicts.some((candidate) => indexToCoords(candidate.from).rank === origin.rank);

      if (sharesFile && sharesRank) {
        disambiguation = `${FILES[origin.file]}${8 - origin.rank}`;
      } else if (sharesFile) {
        disambiguation = String(8 - origin.rank);
      } else {
        disambiguation = FILES[origin.file];
      }
    }
  }

  const captureMarker = move.capture ? "x" : "";
  const promotion = move.promotion ? `=${move.promotion.toUpperCase()}` : "";
  return withSanSuffix(state, move, `${pieceLetter}${disambiguation}${captureMarker}${squareName(move.to)}${promotion}`);
}

function withSanSuffix(state, move, baseSan) {
  const nextState = applyMove(state, move);
  if (!isInCheck(nextState, nextState.turn)) {
    return baseSan;
  }
  return `${baseSan}${generateLegalMoves(nextState).length ? "+" : "#"}`;
}

export function parseUciMove(uci) {
  if (!uci || uci.length < 4) {
    return null;
  }
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  if (from == null || to == null) {
    return null;
  }
  return {
    from,
    to,
    promotion: uci[4] ?? null,
  };
}

function createMove(base) {
  return {
    from: base.from,
    to: base.to,
    piece: { ...base.piece },
    color: base.piece.color,
    capture: base.capture ? { ...base.capture } : null,
    capturedSquare: base.capturedSquare ?? base.to,
    promotion: base.promotion ?? null,
    isEnPassant: Boolean(base.isEnPassant),
    isCastle: Boolean(base.isCastle),
    rookFrom: base.rookFrom ?? null,
    rookTo: base.rookTo ?? null,
  };
}

export function generateLegalMoves(state, color = state.turn) {
  const moves = [];
  for (let index = 0; index < 64; index += 1) {
    const piece = state.board[index];
    if (!piece || piece.color !== color) {
      continue;
    }
    for (const move of generatePseudoMovesForPiece(state, index, piece)) {
      const nextState = applyMove(state, move);
      if (!isInCheck(nextState, color)) {
        moves.push(move);
      }
    }
  }
  return moves;
}

function generatePseudoMovesForPiece(state, index, piece) {
  const { file, rank } = indexToCoords(index);
  const moves = [];

  if (piece.type === "p") {
    const direction = piece.color === "w" ? -1 : 1;
    const startRank = piece.color === "w" ? 6 : 1;
    const promotionRank = piece.color === "w" ? 0 : 7;
    const singleRank = rank + direction;

    if (isOnBoard(file, singleRank)) {
      const singleTarget = coordsToIndex(file, singleRank);
      if (!state.board[singleTarget]) {
        if (singleRank === promotionRank) {
          for (const promotion of PROMOTION_TYPES) {
            moves.push(createMove({ from: index, to: singleTarget, piece, promotion }));
          }
        } else {
          moves.push(createMove({ from: index, to: singleTarget, piece }));
        }

        const doubleRank = rank + direction * 2;
        if (rank === startRank && isOnBoard(file, doubleRank)) {
          const doubleTarget = coordsToIndex(file, doubleRank);
          if (!state.board[doubleTarget]) {
            moves.push(createMove({ from: index, to: doubleTarget, piece }));
          }
        }
      }
    }

    for (const fileStep of [-1, 1]) {
      const targetFile = file + fileStep;
      const targetRank = rank + direction;
      if (!isOnBoard(targetFile, targetRank)) {
        continue;
      }
      const target = coordsToIndex(targetFile, targetRank);
      const occupant = state.board[target];
      if (occupant && occupant.color !== piece.color) {
        if (targetRank === promotionRank) {
          for (const promotion of PROMOTION_TYPES) {
            moves.push(createMove({ from: index, to: target, piece, capture: occupant, promotion }));
          }
        } else {
          moves.push(createMove({ from: index, to: target, piece, capture: occupant }));
        }
      }

      if (state.epSquare === target) {
        const capturedSquare = coordsToIndex(targetFile, rank);
        const capturedPiece = state.board[capturedSquare];
        if (capturedPiece && capturedPiece.type === "p" && capturedPiece.color !== piece.color) {
          moves.push(
            createMove({
              from: index,
              to: target,
              piece,
              capture: capturedPiece,
              capturedSquare,
              isEnPassant: true,
            }),
          );
        }
      }
    }

    return moves;
  }

  if (piece.type === "n") {
    const offsets = [
      [1, 2],
      [2, 1],
      [2, -1],
      [1, -2],
      [-1, -2],
      [-2, -1],
      [-2, 1],
      [-1, 2],
    ];
    for (const [dx, dy] of offsets) {
      const nextFile = file + dx;
      const nextRank = rank + dy;
      if (!isOnBoard(nextFile, nextRank)) {
        continue;
      }
      const target = coordsToIndex(nextFile, nextRank);
      const occupant = state.board[target];
      if (!occupant || occupant.color !== piece.color) {
        moves.push(createMove({ from: index, to: target, piece, capture: occupant }));
      }
    }
    return moves;
  }

  if (piece.type === "k") {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const nextFile = file + dx;
        const nextRank = rank + dy;
        if (!isOnBoard(nextFile, nextRank)) {
          continue;
        }
        const target = coordsToIndex(nextFile, nextRank);
        const occupant = state.board[target];
        if (!occupant || occupant.color !== piece.color) {
          moves.push(createMove({ from: index, to: target, piece, capture: occupant }));
        }
      }
    }

    const enemy = oppositeColor(piece.color);
    if (piece.color === "w" && rank === 7 && file === 4) {
      if (
        state.castling.wK &&
        !state.board[parseSquare("f1")] &&
        !state.board[parseSquare("g1")] &&
        !isSquareAttacked(state, parseSquare("e1"), enemy) &&
        !isSquareAttacked(state, parseSquare("f1"), enemy) &&
        !isSquareAttacked(state, parseSquare("g1"), enemy)
      ) {
        moves.push(
          createMove({
            from: index,
            to: parseSquare("g1"),
            piece,
            isCastle: true,
            rookFrom: parseSquare("h1"),
            rookTo: parseSquare("f1"),
          }),
        );
      }
      if (
        state.castling.wQ &&
        !state.board[parseSquare("d1")] &&
        !state.board[parseSquare("c1")] &&
        !state.board[parseSquare("b1")] &&
        !isSquareAttacked(state, parseSquare("e1"), enemy) &&
        !isSquareAttacked(state, parseSquare("d1"), enemy) &&
        !isSquareAttacked(state, parseSquare("c1"), enemy)
      ) {
        moves.push(
          createMove({
            from: index,
            to: parseSquare("c1"),
            piece,
            isCastle: true,
            rookFrom: parseSquare("a1"),
            rookTo: parseSquare("d1"),
          }),
        );
      }
    }

    if (piece.color === "b" && rank === 0 && file === 4) {
      if (
        state.castling.bK &&
        !state.board[parseSquare("f8")] &&
        !state.board[parseSquare("g8")] &&
        !isSquareAttacked(state, parseSquare("e8"), enemy) &&
        !isSquareAttacked(state, parseSquare("f8"), enemy) &&
        !isSquareAttacked(state, parseSquare("g8"), enemy)
      ) {
        moves.push(
          createMove({
            from: index,
            to: parseSquare("g8"),
            piece,
            isCastle: true,
            rookFrom: parseSquare("h8"),
            rookTo: parseSquare("f8"),
          }),
        );
      }
      if (
        state.castling.bQ &&
        !state.board[parseSquare("d8")] &&
        !state.board[parseSquare("c8")] &&
        !state.board[parseSquare("b8")] &&
        !isSquareAttacked(state, parseSquare("e8"), enemy) &&
        !isSquareAttacked(state, parseSquare("d8"), enemy) &&
        !isSquareAttacked(state, parseSquare("c8"), enemy)
      ) {
        moves.push(
          createMove({
            from: index,
            to: parseSquare("c8"),
            piece,
            isCastle: true,
            rookFrom: parseSquare("a8"),
            rookTo: parseSquare("d8"),
          }),
        );
      }
    }

    return moves;
  }

  const vectors = [];
  if (piece.type === "b" || piece.type === "q") {
    vectors.push(
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    );
  }
  if (piece.type === "r" || piece.type === "q") {
    vectors.push(
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    );
  }

  for (const [dx, dy] of vectors) {
    let nextFile = file + dx;
    let nextRank = rank + dy;
    while (isOnBoard(nextFile, nextRank)) {
      const target = coordsToIndex(nextFile, nextRank);
      const occupant = state.board[target];
      if (!occupant) {
        moves.push(createMove({ from: index, to: target, piece }));
      } else {
        if (occupant.color !== piece.color) {
          moves.push(createMove({ from: index, to: target, piece, capture: occupant }));
        }
        break;
      }
      nextFile += dx;
      nextRank += dy;
    }
  }

  return moves;
}

export function applyMove(state, move) {
  const next = cloneState(state);
  next.epSquare = null;

  const movingPiece = { ...move.piece };
  next.board[move.from] = null;

  if (move.isEnPassant) {
    next.board[move.capturedSquare] = null;
  }

  if (move.capture && !move.isEnPassant) {
    next.board[move.to] = null;
  }

  if (move.promotion) {
    movingPiece.type = move.promotion;
  }

  next.board[move.to] = movingPiece;

  if (move.isCastle) {
    const rook = next.board[move.rookFrom];
    next.board[move.rookFrom] = null;
    next.board[move.rookTo] = rook ? { ...rook } : null;
  }

  if (move.piece.type === "p" && Math.abs(move.to - move.from) === 16) {
    next.epSquare = (move.from + move.to) / 2;
  }

  if (move.piece.type === "k") {
    if (move.color === "w") {
      next.castling.wK = false;
      next.castling.wQ = false;
    } else {
      next.castling.bK = false;
      next.castling.bQ = false;
    }
  }

  if (move.piece.type === "r") {
    disableRookCastlingRight(next, move.color, move.from);
  }

  if (move.capture && move.capture.type === "r") {
    disableRookCastlingRight(next, oppositeColor(move.color), move.capturedSquare);
  }

  next.halfmove = move.piece.type === "p" || move.capture ? 0 : state.halfmove + 1;
  next.fullmove = state.fullmove + (state.turn === "b" ? 1 : 0);
  next.turn = oppositeColor(state.turn);
  return next;
}

function disableRookCastlingRight(state, rookColor, square) {
  if (rookColor === "w") {
    if (square === parseSquare("a1")) {
      state.castling.wQ = false;
    }
    if (square === parseSquare("h1")) {
      state.castling.wK = false;
    }
    return;
  }

  if (square === parseSquare("a8")) {
    state.castling.bQ = false;
  }
  if (square === parseSquare("h8")) {
    state.castling.bK = false;
  }
}

export function findKing(state, color) {
  for (let index = 0; index < 64; index += 1) {
    const piece = state.board[index];
    if (piece && piece.color === color && piece.type === "k") {
      return index;
    }
  }
  return null;
}

export function isSquareAttacked(state, square, byColor) {
  const { file, rank } = indexToCoords(square);

  const pawnRank = byColor === "w" ? rank + 1 : rank - 1;
  for (const pawnFile of [file - 1, file + 1]) {
    if (!isOnBoard(pawnFile, pawnRank)) {
      continue;
    }
    const pawn = state.board[coordsToIndex(pawnFile, pawnRank)];
    if (pawn && pawn.color === byColor && pawn.type === "p") {
      return true;
    }
  }

  const knightOffsets = [
    [1, 2],
    [2, 1],
    [2, -1],
    [1, -2],
    [-1, -2],
    [-2, -1],
    [-2, 1],
    [-1, 2],
  ];

  for (const [dx, dy] of knightOffsets) {
    const nextFile = file + dx;
    const nextRank = rank + dy;
    if (!isOnBoard(nextFile, nextRank)) {
      continue;
    }
    const piece = state.board[coordsToIndex(nextFile, nextRank)];
    if (piece && piece.color === byColor && piece.type === "n") {
      return true;
    }
  }

  const diagonalVectors = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (const [dx, dy] of diagonalVectors) {
    let nextFile = file + dx;
    let nextRank = rank + dy;
    while (isOnBoard(nextFile, nextRank)) {
      const piece = state.board[coordsToIndex(nextFile, nextRank)];
      if (piece) {
        if (piece.color === byColor && (piece.type === "b" || piece.type === "q")) {
          return true;
        }
        break;
      }
      nextFile += dx;
      nextRank += dy;
    }
  }

  const orthogonalVectors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of orthogonalVectors) {
    let nextFile = file + dx;
    let nextRank = rank + dy;
    while (isOnBoard(nextFile, nextRank)) {
      const piece = state.board[coordsToIndex(nextFile, nextRank)];
      if (piece) {
        if (piece.color === byColor && (piece.type === "r" || piece.type === "q")) {
          return true;
        }
        break;
      }
      nextFile += dx;
      nextRank += dy;
    }
  }

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nextFile = file + dx;
      const nextRank = rank + dy;
      if (!isOnBoard(nextFile, nextRank)) {
        continue;
      }
      const piece = state.board[coordsToIndex(nextFile, nextRank)];
      if (piece && piece.color === byColor && piece.type === "k") {
        return true;
      }
    }
  }

  return false;
}

export function isInCheck(state, color) {
  const kingSquare = findKing(state, color);
  if (kingSquare == null) {
    return false;
  }
  return isSquareAttacked(state, kingSquare, oppositeColor(color));
}

export function getGameResult(state) {
  const legalMoves = generateLegalMoves(state);
  if (legalMoves.length) {
    return null;
  }
  if (isInCheck(state, state.turn)) {
    const winner = oppositeColor(state.turn);
    return {
      type: "checkmate",
      winner,
      loser: state.turn,
      score: winner === "w" ? "1-0" : "0-1",
    };
  }
  return {
    type: "stalemate",
    winner: null,
    loser: null,
    score: "1/2-1/2",
  };
}

export function generateFen(state) {
  const rows = [];
  for (let rank = 0; rank < 8; rank += 1) {
    let row = "";
    let emptyCount = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = state.board[coordsToIndex(file, rank)];
      if (!piece) {
        emptyCount += 1;
        continue;
      }
      if (emptyCount) {
        row += String(emptyCount);
        emptyCount = 0;
      }
      row += piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }
    if (emptyCount) {
      row += String(emptyCount);
    }
    rows.push(row);
  }

  const castling = [
    state.castling.wK ? "K" : "",
    state.castling.wQ ? "Q" : "",
    state.castling.bK ? "k" : "",
    state.castling.bQ ? "q" : "",
  ].join("") || "-";

  return `${rows.join("/")} ${state.turn} ${castling} ${state.epSquare == null ? "-" : squareName(state.epSquare)} ${state.halfmove} ${state.fullmove}`;
}

export function parseFen(fen) {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new Error("FEN is incomplete.");
  }

  const [boardPart, turnPart, castlingPart, epPart, halfmovePart = "0", fullmovePart = "1"] = parts;
  const rows = boardPart.split("/");
  if (rows.length !== 8) {
    throw new Error("FEN board has the wrong number of ranks.");
  }

  const board = Array(64).fill(null);
  rows.forEach((row, rank) => {
    let file = 0;
    for (const symbol of row) {
      if (/\d/.test(symbol)) {
        file += Number(symbol);
        continue;
      }
      const color = symbol === symbol.toUpperCase() ? "w" : "b";
      const type = symbol.toLowerCase();
      if (!"kqrbnp".includes(type) || file > 7) {
        throw new Error("FEN contains an invalid piece placement.");
      }
      board[coordsToIndex(file, rank)] = { color, type };
      file += 1;
    }
    if (file !== 8) {
      throw new Error("FEN rank does not add up to eight files.");
    }
  });

  const turn = turnPart === "w" || turnPart === "b" ? turnPart : null;
  if (!turn) {
    throw new Error("FEN turn field is invalid.");
  }

  const epSquare = epPart === "-" ? null : parseSquare(epPart);
  if (epPart !== "-" && epSquare == null) {
    throw new Error("FEN en passant square is invalid.");
  }

  return {
    board,
    turn,
    castling: {
      wK: castlingPart.includes("K"),
      wQ: castlingPart.includes("Q"),
      bK: castlingPart.includes("k"),
      bQ: castlingPart.includes("q"),
    },
    epSquare,
    halfmove: Number.parseInt(halfmovePart, 10) || 0,
    fullmove: Number.parseInt(fullmovePart, 10) || 1,
  };
}

function parsePgnHeaders(text) {
  const headers = {};
  const headerPattern = /^\s*\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"\\])*)"\]\s*$/gm;
  for (const match of text.matchAll(headerPattern)) {
    headers[match[1]] = match[2].replace(/\\"/g, "\"");
  }
  return headers;
}

function normalizeSan(token) {
  return token
    .trim()
    .replaceAll("0-0-0", "O-O-O")
    .replaceAll("0-0", "O-O")
    .replace(/\.\.\./g, "")
    .replace(/[?!]+/g, "")
    .replace(/[+#]+$/g, "")
    .replace(/\s+/g, "")
    .replace(/e\.p\.$/i, "");
}

function stripNestedParentheses(text) {
  let result = text;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(/\([^()]*\)/g, " ");
  }
  return result;
}

function tokenizePgnMoves(text) {
  let movetext = text.replace(/\r/g, "\n");
  movetext = movetext.replace(/^\s*\[[^\]]*\]\s*$/gm, " ");
  movetext = movetext.replace(/\{[\s\S]*?\}/g, " ");
  movetext = movetext.replace(/;[^\n]*/g, " ");
  movetext = stripNestedParentheses(movetext);
  movetext = movetext.replace(/\$\d+/g, " ");
  movetext = movetext.replace(/\d+\.(?:\.\.)?/g, " ");
  movetext = movetext.replace(/(?:\b(?:1-0|0-1|1\/2-1\/2)\b|\*)/g, " ");
  return movetext
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !/^e\.?p\.?$/i.test(token));
}

function matchSanMove(state, token) {
  const normalizedToken = normalizeSan(token);
  const legalMoves = generateLegalMoves(state);
  const matches = legalMoves.filter((move) => normalizeSan(formatSanMove(state, move, legalMoves)) === normalizedToken);
  if (matches.length === 1) {
    return matches[0];
  }
  if (!matches.length) {
    throw new Error(`Could not parse move "${token}".`);
  }
  throw new Error(`Move "${token}" is ambiguous in this position.`);
}

function extractPgnText(sourceText) {
  const trimmed = sourceText.trim();
  if (!trimmed) {
    throw new Error("No game text was provided.");
  }

  if (/^\s*\[Event\s+/m.test(trimmed) || /^\s*\[[A-Za-z0-9_]+\s+"/m.test(trimmed)) {
    return trimmed;
  }

  const embeddedPgnMatch = trimmed.match(/"pgn"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (embeddedPgnMatch) {
    try {
      return JSON.parse(`"${embeddedPgnMatch[1]}"`);
    } catch {
      // Fall through to other extraction heuristics.
    }
  }

  const headerBlockMatch = trimmed.match(/((?:\s*\[[^\]]+\]\s*)+\s*(?:1\.|1\s*\.)[\s\S]+)/);
  if (headerBlockMatch) {
    return headerBlockMatch[1].trim();
  }

  if (/\b1\.(?:\.\.)?\s*/.test(trimmed) || /\b(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/.test(trimmed)) {
    return trimmed;
  }

  throw new Error("Could not find a PGN inside the imported text.");
}

export function parseImportedGame(sourceText) {
  const pgn = extractPgnText(sourceText);
  const headers = parsePgnHeaders(pgn);
  const initialState = headers.SetUp === "1" && headers.FEN ? parseFen(headers.FEN) : createInitialState();
  const moves = [];
  let state = cloneState(initialState);

  for (const token of tokenizePgnMoves(pgn)) {
    const move = matchSanMove(state, token);
    const legalMoves = generateLegalMoves(state);
    moves.push({
      move,
      san: formatSanMove(state, move, legalMoves),
    });
    state = applyMove(state, move);
  }

  if (!moves.length) {
    throw new Error("The imported game does not contain any playable moves.");
  }

  return { headers, initialState, moves, pgn };
}
