// Casual deterministic practice opponent. Prioritises immediate wins/blocks,
// then open lines for either side. Candidate search stays near existing stones.
import { ROWS, COLS, stoneOf, otherSeat, winningLineAt, type Cell, type OmokGame } from './engine';
export function findBotMove(game: OmokGame, seat: number): { row: number; col: number } | null {
  if (game.phase !== 'play' || seat !== game.currentSeat) return null;
  if (!game.moveCount) return { row: 7, col: 7 };
  const board = game.board.map(row => [...row]);
  const candidates: { row: number; col: number }[] = [];
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    if (board[row][col]) continue;
    if (board.some((line, r) => Math.abs(r - row) <= 2 && line.some((v, c) => v && Math.abs(c - col) <= 2))) candidates.push({ row, col });
  }
  // Stable centre-out ties make practice reproducible, while still spotting edges.
  candidates.sort((a, b) => (Math.abs(a.row - 7) + Math.abs(a.col - 7)) - (Math.abs(b.row - 7) + Math.abs(b.col - 7)));
  const mine = stoneOf(game, seat), theirs = stoneOf(game, otherSeat(seat));
  for (const stone of [mine, theirs]) for (const move of candidates) {
    board[move.row][move.col] = stone;
    const wins = winningLineAt(board, move.row, move.col);
    board[move.row][move.col] = 0;
    if (wins) return move;
  }
  function score(row: number, col: number, stone: Cell): number {
    let total = 0;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let count = 1, open = 0;
      for (const sign of [-1, 1]) {
        let r = row + dr * sign, c = col + dc * sign;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === stone) {
          count++; r += dr * sign; c += dc * sign;
        }
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && !board[r][c]) open++;
      }
      if (open) total += [0, 2, 14, 110, 1200, 100000][Math.min(count, 5)] * open;
    }
    return total;
  }
  let best = -Infinity, chosen = candidates[0] ?? null;
  for (const move of candidates) {
    const value = score(move.row, move.col, mine) + score(move.row, move.col, theirs) * 0.95;
    if (value > best) { best = value; chosen = move; }
  }
  return chosen;
}
