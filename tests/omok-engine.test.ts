import { describe, expect, it } from 'vitest';
import { COLS, ROWS, newGame, placeStone, resignGame, stoneOf, winningLineAt, type Cell } from '../src/omok/engine';
import { findBotMove } from '../src/omok/bot';

describe('freestyle Omok rules', () => {
  it.each([0, 1])('black opens independently of roster order (%s)', black => {
    const g = newGame(black);
    expect(g.board).toHaveLength(15);
    expect(g.board.every(row => row.length === 15 && row.every(v => !v))).toBe(true);
    expect(g.currentSeat).toBe(black);
    expect(placeStone(g, black, 0, 14)).toBeNull();
    expect(g.board[0][14]).toBe(1);
    expect(g.currentSeat).toBe(1 - black);
    expect(placeStone(g, 1 - black, 14, 0)).toBeNull();
    expect(g.board[14][0]).toBe(2);
    expect(g.lastMove).toEqual({ seat: 1 - black, row: 14, col: 0 });
    expect(g.log.map(e => e.seq)).toEqual([1, 2]);
  });
  it.each([[0,1,0,10], [1,0,10,14], [1,1,10,10], [1,-1,10,4]])('detects five at edges in direction %s,%s', (dr,dc,r,c) => {
    for (const black of [0,1]) {
      const g = newGame(black);
      for (let i = 0; i < 4; i++) g.board[r+i*dr][c+i*dc] = stoneOf(g, black);
      expect(placeStone(g, black, r+4*dr, c+4*dc)).toBeNull();
      expect(g.phase).toBe('done'); expect(g.winner).toBe(black);
      expect(g.winningLine).toHaveLength(5); expect(g.endReason).toBe('five');
      expect(g.log.at(-1)).toMatchObject({ t: 'win', seat: black });
    }
  });
  it('counts overlines, permits double threats, and does not join across gaps or board edges', () => {
    const g = newGame();
    for (const c of [1,2,3,5,6]) g.board[7][c] = 1;
    expect(placeStone(g, 0, 7, 4)).toBeNull();
    expect(g.winningLine).toHaveLength(6);
    const board = newGame().board;
    for (const c of [0,1,3,4]) board[0][c] = 1;
    expect(winningLineAt(board,0,0)).toBeNull();
    board[0][14]=1; board[1][0]=1; board[1][1]=1;
    expect(winningLineAt(board,0,14)).toBeNull();
    const threats = newGame();
    for (const [r,c] of [[7,6],[7,8],[6,7],[8,7]]) threats.board[r][c]=1;
    expect(placeStone(threats,0,7,7)).toBeNull();
    expect(threats.phase).toBe('play');
  });
  it.each([[-1,0], [15,0], [0,15], [0,-1], [1.5,2], [NaN,2], [2,Infinity]])('rejects invalid point %s,%s without mutation', (r,c) => {
    const g = newGame(), before = structuredClone(g);
    expect(placeStone(g,0,r,c)).toBeTruthy(); expect(g).toEqual(before);
  });
  it('rejects wrong turns, occupied points and moves after completion', () => {
    const g = newGame();
    expect(placeStone(g,1,7,7)).toContain('turn');
    expect(placeStone(g,0,7,7)).toBeNull();
    const before = structuredClone(g);
    expect(placeStone(g,1,7,7)).toContain('occupied'); expect(g).toEqual(before);
    expect(resignGame(g,0)).toBeNull();
    expect(g.winner).toBe(1); expect(g.endReason).toBe('resign');
    expect(placeStone(g,1,8,8)).toContain('over');
    expect(resignGame(g,1)).toContain('over');
  });
  it('draws only on the last empty intersection, while a winning last move takes priority', () => {
    const g = newGame();
    g.board = Array.from({length:ROWS},(_,r)=>Array.from({length:COLS},(_,c)=>((Math.floor(r/2)+c)%2+1) as Cell));
    g.board[14][14]=0; g.moveCount=224; g.currentSeat=1;
    expect(placeStone(g,1,14,14)).toBeNull(); expect(g.isDraw).toBe(true); expect(g.winner).toBeNull();
    const win = newGame(); win.moveCount=224;
    for (let c=0;c<4;c++) win.board[0][c]=1;
    placeStone(win,0,0,4); expect(win.winner).toBe(0); expect(win.isDraw).toBe(false);
  });
});

describe('Omok practice opponent', () => {
  it.each([0,1])('opens centrally and makes immediate wins and blocks for either colour (%s)', black => {
    const g = newGame(black);
    expect(findBotMove(g,black)).toEqual({row:7,col:7});
    expect(findBotMove(g,1-black)).toBeNull();
    for (const defend of [false,true]) {
      const game = newGame(black); game.moveCount=4;
      for (let c=0;c<4;c++) game.board[14][c]=defend ? 2 : 1;
      const before=structuredClone(game);
      expect(findBotMove(game,black)).toEqual({row:14,col:4}); expect(game).toEqual(before);
    }
  });
  it('takes its own win before blocking and returns null after the game ends', () => {
    const g=newGame(); g.moveCount=8;
    for(let c=0;c<4;c++) { g.board[0][c]=1; g.board[14][c]=2; }
    expect(findBotMove(g,0)).toEqual({row:0,col:4});
    placeStone(g,0,0,4); expect(findBotMove(g,0)).toBeNull();
  });
  it('plays a complete legal deterministic game without mutating during search', () => {
    const g=newGame(1);
    while(g.phase==='play') {
      const before=structuredClone(g), move=findBotMove(g,g.currentSeat);
      expect(g).toEqual(before); expect(move).not.toBeNull();
      expect(placeStone(g,g.currentSeat,move!.row,move!.col)).toBeNull();
      expect(g.moveCount).toBeLessThanOrEqual(225);
    }
    expect(g.winner !== null || g.isDraw).toBe(true);
  });
});
