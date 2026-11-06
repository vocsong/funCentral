import { describe, it, expect } from 'vitest';
import {
  COLS,
  ROWS,
  discOf,
  dropDisc,
  legalCols,
  newGame,
  otherSeat,
  winningLineAt,
  type Connect4Game,
} from '../src/connect4/engine';

type Cell = Connect4Game['board'][number][number];

/** A game with a fixed board and turn, for targeted rules checks. */
function setup(patch: Partial<Connect4Game> = {}): Connect4Game {
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
    ...patch,
  };
}

/** Fill a column from the bottom up with the given disc values (1 = seat 0, 2 = seat 1). */
function fillCol(game: Connect4Game, col: number, discs: number[]): void {
  for (let i = 0; i < discs.length; i++) {
    const row = ROWS - 1 - i;
    game.board[row][col] = discs[i] as Cell;
  }
  game.heights[col] = discs.length;
  game.moveCount += discs.length;
}

describe('connect4 board basics', () => {
  it('has a 7×6 board and two players', () => {
    const g = newGame();
    expect(COLS).toBe(7);
    expect(ROWS).toBe(6);
    expect(g.board).toHaveLength(6);
    expect(g.board.every((row) => row.length === 7 && row.every((c) => c === 0))).toBe(true);
    expect(g.currentSeat).toBe(0);
    expect(g.phase).toBe('play');
  });

  it('maps seats to disc values and toggles turns', () => {
    expect(discOf(0)).toBe(1);
    expect(discOf(1)).toBe(2);
    expect(otherSeat(0)).toBe(1);
    expect(otherSeat(1)).toBe(0);
  });

  it('lists all columns as legal on an empty board, and none on a full one', () => {
    const g = newGame();
    expect(legalCols(g)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    g.heights = Array<number>(COLS).fill(ROWS);
    expect(legalCols(g)).toEqual([]);
  });
});

describe('dropDisc', () => {
  it('drops into the lowest empty row of the chosen column and advances the turn', () => {
    const g = newGame();
    expect(dropDisc(g, 0, 3)).toBeNull();
    expect(g.board[5][3]).toBe(1);
    expect(g.lastMove).toEqual({ seat: 0, col: 3, row: 5 });
    expect(g.currentSeat).toBe(1);
    expect(dropDisc(g, 1, 3)).toBeNull();
    expect(g.board[4][3]).toBe(2);
  });

  it('rejects out-of-turn, out-of-range and full-column moves', () => {
    const g = newGame();
    expect(dropDisc(g, 1, 0)).toBe("It's not your turn");
    expect(dropDisc(g, 0, -1)).toBe('Pick a column');
    expect(dropDisc(g, 0, 7)).toBe('Pick a column');
    expect(dropDisc(g, 0, 1.5)).toBe('Pick a column');
    fillCol(g, 0, [1, 2, 1, 2, 1, 2]);
    expect(dropDisc(g, 0, 0)).toBe('That column is full');
  });

  it('rejects moves once the game is over', () => {
    const g = newGame();
    g.phase = 'done';
    expect(dropDisc(g, 0, 0)).toBe('The game is over');
  });

  it('detects a horizontal win', () => {
    const g = setup();
    fillCol(g, 0, [1, 1, 1]);
    fillCol(g, 1, [1, 1, 1]);
    fillCol(g, 2, [1, 1, 1]);
    expect(dropDisc(g, 0, 3)).toBeNull(); // seat 0 completes a row of four 1s on the bottom
    expect(g.phase).toBe('done');
    expect(g.winner).toBe(0);
    expect(g.isDraw).toBe(false);
    expect(g.winningLine).toEqual([[5, 0], [5, 1], [5, 2], [5, 3]]);
  });

  it('detects a vertical win', () => {
    const g = setup();
    for (let i = 0; i < 3; i++) {
      dropDisc(g, 0, 0);
      dropDisc(g, 1, 1);
    }
    expect(dropDisc(g, 0, 0)).toBeNull();
    expect(g.winner).toBe(0);
    expect(g.winningLine).toEqual([[2, 0], [3, 0], [4, 0], [5, 0]]);
  });

  it('detects a diagonal win', () => {
    const g = setup();
    // Rising diagonal (5,0) → (2,3), all disc 1.
    fillCol(g, 0, [1]);
    fillCol(g, 1, [2, 1]);
    fillCol(g, 2, [2, 2, 1]);
    fillCol(g, 3, [2, 2, 2]);
    expect(dropDisc(g, 0, 3)).toBeNull(); // lands at row 2
    expect(g.winner).toBe(0);
    expect(g.winningLine).toEqual(expect.arrayContaining([[5, 0], [4, 1], [3, 2], [2, 3]]));
  });

  it('declares a draw when the board fills with no winner', () => {
    const g = setup();
    // Columns alternate in pairs (bottom colours R R Y Y R R Y), which avoids
    // four of the same disc horizontally, vertically and diagonally.
    const R = 1;
    const Y = 2;
    const drawPatterns = [
      [R, Y, R, Y, R, Y], // c0
      [R, Y, R, Y, R, Y], // c1
      [Y, R, Y, R, Y, R], // c2
      [Y, R, Y, R, Y, R], // c3
      [R, Y, R, Y, R, Y], // c4
      [R, Y, R, Y, R, Y], // c5
      [Y, R, Y, R, Y, R], // c6
    ];
    for (let col = 0; col < COLS; col++) {
      const discs = col === 6 ? drawPatterns[col].slice(0, 5) : drawPatterns[col];
      fillCol(g, col, discs);
    }
    expect(dropDisc(g, 0, 6)).toBeNull();
    expect(g.phase).toBe('done');
    expect(g.isDraw).toBe(true);
    expect(g.winner).toBeNull();
    expect(g.moveCount).toBe(ROWS * COLS);
  });
});

describe('winningLineAt', () => {
  it('returns null when no four connect through the cell', () => {
    const g = newGame();
    dropDisc(g, 0, 0);
    expect(winningLineAt(g.board, 5, 0)).toBeNull();
  });

  it('finds a horizontal run of four', () => {
    const g = setup();
    fillCol(g, 0, [1, 2]);
    fillCol(g, 1, [1, 2]);
    fillCol(g, 2, [1, 2]);
    fillCol(g, 3, [1]);
    const line = winningLineAt(g.board, 5, 3);
    expect(line).toEqual([[5, 0], [5, 1], [5, 2], [5, 3]]);
  });
});
