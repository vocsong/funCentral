// Pure Connect 4 rules engine — exactly two players, a 7-column × 6-row board.
// No Cloudflare dependencies. The room stays authoritative; this module only
// validates a move against the given state.

export const COLS = 7;
export const ROWS = 6;
export const WIN_LENGTH = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 2;

export type Phase = 'play' | 'done';

/** Board cells: 0 = empty, 1 = seat 0's disc, 2 = seat 1's disc. */
export type Cell = 0 | 1 | 2;

export type LogEntry = { seq: number } & (
  | { t: 'drop'; seat: number; col: number; row: number }
  | { t: 'win'; seat: number }
  | { t: 'draw' }
);

export interface Connect4Game {
  /** ROWS × COLS grid; board[0] is the top row as drawn. */
  board: Cell[][];
  /** Discs already in each column (the drop row is derived from this). */
  heights: number[];
  /** Whose turn it is (0 or 1). */
  currentSeat: number;
  phase: Phase;
  winner: number | null;
  isDraw: boolean;
  /** Cells forming the winning run, or null. */
  winningLine: [number, number][] | null;
  lastMove: { seat: number; col: number; row: number } | null;
  moveCount: number;
  log: LogEntry[];
  seq: number;
}

const LOG_LIMIT = 42;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type LogInput = DistributiveOmit<LogEntry, 'seq'>;

/** Disc value for a seat (1 or 2). */
export function discOf(seat: number): Cell {
  return (seat === 0 ? 1 : 2) as Cell;
}

export function otherSeat(seat: number): number {
  return 1 - seat;
}

function addLog(game: Connect4Game, entry: LogInput): void {
  game.seq += 1;
  game.log.push({ ...entry, seq: game.seq } as LogEntry);
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

export function newGame(): Connect4Game {
  return {
    board: Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(0)),
    heights: Array<number>(COLS).fill(0),
    currentSeat: 0,
    phase: 'play',
    winner: null,
    isDraw: false,
    winningLine: null,
    lastMove: null,
    moveCount: 0,
    log: [],
    seq: 0,
  };
}

/** Columns that still have an empty cell (in left-to-right order). */
export function legalCols(game: Connect4Game): number[] {
  const cols: number[] = [];
  for (let c = 0; c < COLS; c++) if (game.heights[c] < ROWS) cols.push(c);
  return cols;
}

/** The contiguous winning run through (row, col), or null when it does not complete four. */
export function winningLineAt(board: Cell[][], row: number, col: number): [number, number][] | null {
  const disc = board[row][col];
  if (!disc) return null;
  const dirs: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const cells: [number, number][] = [[row, col]];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === disc) {
      cells.push([r, c]);
      r += dr;
      c += dc;
    }
    r = row - dr;
    c = col - dc;
    while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === disc) {
      cells.unshift([r, c]);
      r -= dr;
      c -= dc;
    }
    if (cells.length >= WIN_LENGTH) return cells;
  }
  return null;
}

function guardTurn(game: Connect4Game, seat: number): string | null {
  if (game.phase !== 'play') return 'The game is over';
  if (seat !== game.currentSeat) return "It's not your turn";
  return null;
}

/**
 * Drop a disc in `col` for `seat`. Applies the move in place and returns an
 * error string for the sender, or null on success.
 */
export function dropDisc(game: Connect4Game, seat: number, col: number): string | null {
  const turn = guardTurn(game, seat);
  if (turn) return turn;
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return 'Pick a column';
  if (game.heights[col] >= ROWS) return 'That column is full';

  const row = ROWS - 1 - game.heights[col];
  game.board[row][col] = discOf(seat);
  game.heights[col] += 1;
  game.moveCount += 1;
  game.lastMove = { seat, col, row };
  addLog(game, { t: 'drop', seat, col, row });

  const line = winningLineAt(game.board, row, col);
  if (line) {
    game.phase = 'done';
    game.winner = seat;
    game.winningLine = line;
    addLog(game, { t: 'win', seat });
    return null;
  }
  if (game.moveCount >= ROWS * COLS) {
    game.phase = 'done';
    game.isDraw = true;
    addLog(game, { t: 'draw' });
    return null;
  }
  game.currentSeat = otherSeat(seat);
  return null;
}
