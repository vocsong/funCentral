// Pure Connect 4 bot — depth-limited negamax with alpha-beta pruning and a
// window-counting heuristic, plus immediate win/block checks. No Cloudflare
// dependencies, so it is unit-testable in isolation.

import {
  COLS,
  ROWS,
  discOf,
  legalCols,
  otherSeat,
  winningLineAt,
  type Cell,
  type Connect4Game,
} from './engine';

// Casual practice: see short tactics, but leave longer traps for the human.
export const BOT_DEPTH = 2;

const WIN_SCORE = 100000;
/** Points for 1, 2, 3 or 4 of your discs in an unblocked 4-cell window. */
const WINDOW_SCORE = [0, 1, 10, 50, WIN_SCORE];
/** Center columns are stronger in Connect 4; weight discs by column. */
const CENTER_WEIGHT = [3, 4, 5, 7, 5, 4, 3];

type Board = Cell[][];

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

interface Drop {
  board: Board;
  heights: number[];
  row: number;
}

/** Simulates a drop into `col`; returns null when the column is full. */
function simulate(board: Board, heights: number[], col: number, disc: Cell): Drop | null {
  if (heights[col] >= ROWS) return null;
  const row = ROWS - 1 - heights[col];
  const next = cloneBoard(board);
  next[row][col] = disc;
  const nextHeights = [...heights];
  nextHeights[col] += 1;
  return { board: next, heights: nextHeights, row };
}

/** Legal columns ordered center-out, which improves alpha-beta pruning. */
function orderedCols(heights: number[]): number[] {
  const cols: number[] = [];
  for (let c = 0; c < COLS; c++) if (heights[c] < ROWS) cols.push(c);
  return cols.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3));
}

/** Score one 4-cell window from the perspective of `myDisc`. */
function scoreWindow(board: Board, r: number, c: number, dr: number, dc: number, myDisc: Cell, oppDisc: Cell): number {
  let mine = 0;
  let theirs = 0;
  for (let i = 0; i < 4; i++) {
    const cell = board[r + dr * i][c + dc * i];
    if (cell === myDisc) mine += 1;
    else if (cell === oppDisc) theirs += 1;
  }
  if (mine > 0 && theirs > 0) return 0; // a blocked window can't be won by either side
  if (mine === 0 && theirs === 0) return 0;
  return mine > 0 ? WINDOW_SCORE[mine] : -WINDOW_SCORE[theirs];
}

/** Heuristic evaluation of a position from `seat`'s perspective. */
function evaluate(board: Board, seat: number): number {
  const myDisc = discOf(seat);
  const oppDisc = discOf(otherSeat(seat));
  let score = 0;

  // Horizontal windows.
  for (let r = 0; r < ROWS; r++) for (let c = 0; c <= COLS - 4; c++) score += scoreWindow(board, r, c, 0, 1, myDisc, oppDisc);
  // Vertical windows.
  for (let r = 0; r <= ROWS - 4; r++) for (let c = 0; c < COLS; c++) score += scoreWindow(board, r, c, 1, 0, myDisc, oppDisc);
  // Diagonal (down-right).
  for (let r = 0; r <= ROWS - 4; r++) for (let c = 0; c <= COLS - 4; c++) score += scoreWindow(board, r, c, 1, 1, myDisc, oppDisc);
  // Diagonal (up-right).
  for (let r = 3; r < ROWS; r++) for (let c = 0; c <= COLS - 4; c++) score += scoreWindow(board, r, c, -1, 1, myDisc, oppDisc);

  // Positional bonus: own discs near the center are good, opponent discs bad.
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = board[r][c];
      if (cell === myDisc) score += CENTER_WEIGHT[c];
      else if (cell === oppDisc) score -= CENTER_WEIGHT[c];
    }
  }
  return score;
}

/**
 * Negamax: returns the best score `seat` can achieve from `board`/`heights`
 * with `depth` plies remaining. Positive means good for `seat`.
 */
function bestScore(board: Board, heights: number[], seat: number, depth: number, alpha: number, beta: number): number {
  const myDisc = discOf(seat);
  let best = -Infinity;
  for (const col of orderedCols(heights)) {
    const drop = simulate(board, heights, col, myDisc);
    if (!drop) continue;
    if (winningLineAt(drop.board, drop.row, col)) {
      best = Math.max(best, WIN_SCORE + depth); // prefer faster wins
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
      continue;
    }
    const score = depth <= 1
      ? evaluate(drop.board, seat)
      : -bestScore(drop.board, drop.heights, otherSeat(seat), depth - 1, -beta, -alpha);
    best = Math.max(best, score);
    alpha = Math.max(alpha, best);
    if (alpha >= beta) break;
  }
  return best === -Infinity ? 0 : best; // no legal moves: draw
}

/**
 * Chooses the bot's move for `seat`. Returns a legal column, or null when the
 * game is over, it isn't `seat`'s turn, or no column is open.
 */
export function findBotMove(game: Connect4Game, seat: number, depth = BOT_DEPTH): number | null {
  if (game.phase !== 'play' || seat !== game.currentSeat) return null;
  const legal = legalCols(game);
  if (legal.length === 0) return null;
  const myDisc = discOf(seat);
  const oppDisc = discOf(otherSeat(seat));
  const ordered = orderedCols(game.heights);

  // 1. Take an immediate win.
  for (const col of ordered) {
    const drop = simulate(game.board, game.heights, col, myDisc);
    if (drop && winningLineAt(drop.board, drop.row, col)) return col;
  }

  // 2. Block the opponent's immediate win.
  for (const col of ordered) {
    const drop = simulate(game.board, game.heights, col, oppDisc);
    if (drop && winningLineAt(drop.board, drop.row, col)) return col;
  }

  // 3. Search.
  let bestCol = ordered[0];
  let best = -Infinity;
  for (const col of ordered) {
    const drop = simulate(game.board, game.heights, col, myDisc)!;
    const score = -bestScore(drop.board, drop.heights, otherSeat(seat), depth - 1, -Infinity, Infinity);
    if (score > best) {
      best = score;
      bestCol = col;
    }
  }
  return bestCol;
}
