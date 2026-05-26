import {
  PIECE_VALUES,
  isSquareAttacked,
  moveToUci,
  oppositeColor,
} from "./chess.js";

export function buildMoveFeedback(
  baseline,
  responseAnalysis,
  playedMove,
  responseTurn,
  preMoveState,
  postMoveState,
  perspectiveColor,
) {
  const playedUci = moveToUci(playedMove);

  if (!baseline || !baseline.score || !responseAnalysis.score) {
    return {
      tone: "good",
      label: playedUci === baseline?.bestmove ? "Best" : "Played",
      detail: "Evaluation unavailable",
      loss: null,
      bestUci: baseline?.bestmove ?? null,
    };
  }

  const baselineValue = scoreFromPlayerPerspective(
    baseline.score,
    preMoveState?.turn ?? perspectiveColor,
    perspectiveColor,
  );
  const responseValue = scoreFromPlayerPerspective(responseAnalysis.score, responseTurn, perspectiveColor);
  const loss = Math.max(0, Math.round(baselineValue - responseValue));
  const playedBest = playedUci === baseline.bestmove;
  const moveSwing = responseValue - baselineValue;
  const sacrifice = Boolean(preMoveState && postMoveState && isBrilliantSacrifice(preMoveState, postMoveState, playedMove));

  if (playedBest && sacrifice && responseValue > -80 && baselineValue < 600) {
    return {
      tone: "brilliant",
      label: "Brilliant",
      detail: "Best sacrifice found",
      loss: 0,
      bestUci: baseline.bestmove,
    };
  }

  if (playedBest && isGreatMove(baselineValue, responseValue, moveSwing)) {
    return {
      tone: "great",
      label: "Great Move",
      detail: "Critical move found",
      loss: 0,
      bestUci: baseline.bestmove,
    };
  }

  if (!playedBest && isMiss(baselineValue, responseValue)) {
    return {
      tone: "miss",
      label: "Miss",
      detail: `${loss} cp lost`,
      loss,
      bestUci: baseline.bestmove,
    };
  }

  if (playedBest) {
    return {
      tone: "best",
      label: "Best",
      detail: "Matched Stockfish",
      loss: 0,
      bestUci: baseline.bestmove,
    };
  }

  if (loss <= 25) {
    return {
      tone: "excellent",
      label: "Excellent",
      detail: `${loss} cp lost`,
      loss,
      bestUci: baseline.bestmove,
    };
  }

  if (loss <= 80) {
    return {
      tone: "good",
      label: "Good",
      detail: `${loss} cp lost`,
      loss,
      bestUci: baseline.bestmove,
    };
  }

  if (loss <= 160) {
    return {
      tone: "inaccuracy",
      label: "Inaccuracy",
      detail: `${loss} cp lost`,
      loss,
      bestUci: baseline.bestmove,
    };
  }

  if (loss <= 300) {
    return {
      tone: "mistake",
      label: "Mistake",
      detail: `${loss} cp lost`,
      loss,
      bestUci: baseline.bestmove,
    };
  }

  return {
    tone: "blunder",
    label: "Blunder",
    detail: `${loss} cp lost`,
    loss,
    bestUci: baseline.bestmove,
  };
}

function materialBalanceForColor(state, color) {
  let total = 0;
  for (const piece of state.board) {
    if (!piece) {
      continue;
    }
    const value = PIECE_VALUES[piece.type] ?? 0;
    total += piece.color === color ? value : -value;
  }
  return total;
}

function isBrilliantSacrifice(preMoveState, postMoveState, playedMove) {
  const movedPiece = postMoveState.board[playedMove.to];
  if (!movedPiece || movedPiece.type === "p" || movedPiece.type === "k") {
    return false;
  }

  const netBefore = materialBalanceForColor(preMoveState, playedMove.color);
  const netAfter = materialBalanceForColor(postMoveState, playedMove.color);
  const capturedValue = playedMove.capture ? PIECE_VALUES[playedMove.capture.type] ?? 0 : 0;
  const movedValue = PIECE_VALUES[movedPiece.type] ?? 0;
  const isHanging = isSquareAttacked(postMoveState, playedMove.to, oppositeColor(playedMove.color))
    && !isSquareAttacked(postMoveState, playedMove.to, playedMove.color);

  return isHanging && movedValue - capturedValue >= 2 && netAfter <= netBefore;
}

function isGreatMove(baselineValue, responseValue, moveSwing) {
  return (
    (baselineValue <= -180 && responseValue >= -40) ||
    (baselineValue <= 20 && responseValue >= 180) ||
    moveSwing >= 240
  );
}

function isMiss(baselineValue, responseValue) {
  return baselineValue >= 220 && responseValue <= 70;
}

export function scoreToNumeric(score) {
  if (!score) {
    return 0;
  }
  if (score.kind === "mate") {
    const distance = Math.min(Math.abs(score.value), 100);
    return Math.sign(score.value) * (100000 - distance * 1000);
  }
  return score.value;
}

export function scoreFromPlayerPerspective(score, positionTurn, playerColor) {
  const raw = scoreToNumeric(score);
  return positionTurn === playerColor ? raw : -raw;
}

export function formatScore(score, positionTurn, perspectiveColor) {
  if (!score) {
    return "--";
  }
  const multiplier = positionTurn === perspectiveColor ? 1 : -1;
  if (score.kind === "mate") {
    const pov = score.value * multiplier;
    return pov > 0 ? `M${pov}` : `-M${Math.abs(pov)}`;
  }
  const cp = score.value * multiplier;
  const pawns = (cp / 100).toFixed(1);
  return `${cp >= 0 ? "+" : ""}${pawns}`;
}

export function evalFillPercent(score, positionTurn) {
  if (!score) {
    return 50;
  }
  const numeric = scoreFromPlayerPerspective(score, positionTurn, "w");
  const percent = 1 / (1 + Math.exp(-numeric / 220));
  return Math.max(0, Math.min(100, percent * 100));
}

export function whitePerspectiveScore(score, positionTurn) {
  return scoreFromPlayerPerspective(score, positionTurn, "w");
}

export function formatWhitePerspectiveNumeric(numeric) {
  if (Math.abs(numeric) >= 90000) {
    return numeric > 0 ? "Mate for White" : "Mate for Black";
  }
  const pawns = Math.abs(numeric / 100).toFixed(1);
  if (Math.abs(numeric) < 35) {
    return "Balanced";
  }
  return numeric > 0 ? `White edge +${pawns}` : `Black edge +${pawns}`;
}
