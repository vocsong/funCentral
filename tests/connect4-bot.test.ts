import { describe, it, expect } from 'vitest';
import { newGame, ROWS, type Cell, type Connect4Game } from '../src/connect4/engine';
import { BOT_DEPTH, findBotMove } from '../src/connect4/bot';

/** Build a game with given per-column bottom-up discs (1 = seat 0, 2 = seat 1). */
function gameWith(cols: number[][], currentSeat: number): Connect4Game {
  const g = newGame();
  cols.forEach((discs, col) => {
    discs.forEach((d, i) => { g.board[ROWS - 1 - i][col] = d as Cell; });
    g.heights[col] = discs.length;
    g.moveCount += discs.length;
  });
  g.currentSeat = currentSeat;
  return g;
}

describe('connect4 bot', () => {
  it('defaults to a casual two-ply search', () => {
    expect(BOT_DEPTH).toBe(2);
    const game = gameWith([[1, 2], [2, 1], [], [1], [2, 1, 1], [], [2]], 0);
    expect(findBotMove(game, 0)).toBe(findBotMove(game, 0, 2));
  });

  it('returns null when it is not your turn or the game is over', () => {
    const g = newGame();
    expect(findBotMove(g, 1)).toBeNull();
    g.phase = 'done';
    expect(findBotMove(g, 0)).toBeNull();
  });

  it('takes an immediate win', () => {
    // Seat 0 has three in a row along the bottom; column 3 completes it.
    const g = gameWith([[1], [1], [1], [], [], [], []], 0);
    expect(findBotMove(g, 0)).toBe(3);
  });

  it('blocks the opponent immediate win', () => {
    // Seat 1 has three in a row along the bottom; seat 0 must block at column 3.
    const g = gameWith([[2], [2], [2], [], [], [], []], 0);
    expect(findBotMove(g, 0)).toBe(3);
  });

  it('prefers the centre column on an empty board', () => {
    expect(findBotMove(newGame(), 0)).toBe(3);
  });

  it('returns a legal column for a mid-game position', () => {
    const g = gameWith([[1, 2], [2, 1], [], [1], [2, 1, 1], [], [2]], 0);
    const col = findBotMove(g, 0);
    expect(col).not.toBeNull();
    expect(g.heights[col!]).toBeLessThan(ROWS);
  });
});
