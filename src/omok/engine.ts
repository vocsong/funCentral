// Freestyle Omok: 15 intersections per side, black opens, five or more wins.
// Pure rules. All submitted coordinates and turns are validated by the room.
export const COLS = 15;
export const ROWS = 15;
export const WIN_LENGTH = 5;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 2;
export type Cell = 0 | 1 | 2; // empty / black / white
export type LogEntry = { seq: number } & (
  | { t: 'place'; seat: number; row: number; col: number }
  | { t: 'win'; seat: number }
  | { t: 'resign'; seat: number }
  | { t: 'draw' }
);
export interface OmokGame {
  board: Cell[][];
  blackSeat: number;
  currentSeat: number;
  phase: 'play' | 'done';
  winner: number | null;
  isDraw: boolean;
  winningLine: [number, number][] | null;
  lastMove: { seat: number; row: number; col: number } | null;
  moveCount: number;
  log: LogEntry[];
  seq: number;
  endReason: 'five' | 'draw' | 'resign' | null;
}
type LogInput = LogEntry extends infer T ? T extends LogEntry ? Omit<T, 'seq'> : never : never;
function addLog(game: OmokGame, entry: LogInput): void {
  game.log.push({ ...entry, seq: ++game.seq } as LogEntry);
}
export const otherSeat = (seat: number): number => 1 - seat;
export const stoneOf = (game: Pick<OmokGame, 'blackSeat'>, seat: number): Cell => seat === game.blackSeat ? 1 : 2;
export function newGame(blackSeat = 0): OmokGame {
  return {
    board: Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(0)),
    blackSeat, currentSeat: blackSeat, phase: 'play', winner: null, isDraw: false,
    winningLine: null, lastMove: null, moveCount: 0, log: [], seq: 0, endReason: null,
  };
}
export function winningLineAt(board: Cell[][], row: number, col: number): [number, number][] | null {
  const stone = board[row]?.[col];
  if (!stone) return null;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line: [number, number][] = [[row, col]];
    for (const sign of [-1, 1]) {
      let r = row + sign * dr, c = col + sign * dc;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === stone) {
        if (sign < 0) line.unshift([r, c]); else line.push([r, c]);
        r += sign * dr; c += sign * dc;
      }
    }
    if (line.length >= WIN_LENGTH) return line;
  }
  return null;
}
export function placeStone(game: OmokGame, seat: number, row: number, col: number): string | null {
  if (game.phase !== 'play') return 'The game is over';
  if ((seat !== 0 && seat !== 1) || seat !== game.currentSeat) return "It's not your turn";
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= ROWS || col < 0 || col >= COLS) return 'Choose an intersection on the board';
  if (game.board[row][col]) return 'That intersection is occupied';
  game.board[row][col] = stoneOf(game, seat);
  game.moveCount++;
  game.lastMove = { seat, row, col };
  addLog(game, { t: 'place', seat, row, col });
  const line = winningLineAt(game.board, row, col);
  if (line) {
    game.phase = 'done'; game.winner = seat; game.winningLine = line; game.endReason = 'five';
    addLog(game, { t: 'win', seat });
  } else if (game.moveCount === ROWS * COLS) {
    game.phase = 'done'; game.isDraw = true; game.endReason = 'draw';
    addLog(game, { t: 'draw' });
  } else game.currentSeat = otherSeat(seat);
  return null;
}
export function resignGame(game: OmokGame, seat: number): string | null {
  if (game.phase !== 'play') return 'The game is over';
  if (seat !== 0 && seat !== 1) return "You're watching this game";
  game.phase = 'done'; game.winner = otherSeat(seat); game.endReason = 'resign';
  addLog(game, { t: 'resign', seat });
  return null;
}
