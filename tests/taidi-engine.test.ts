import { describe, it, expect } from 'vitest';
import {
  beats,
  cardPower,
  checkPlay,
  classify,
  fullDeck,
  newGame,
  pass,
  placementsFor,
  playCards,
  sortCards,
  type Rng,
  type TaiDiGame,
} from '../src/taidi/engine';

/** Small deterministic PRNG so shuffles are reproducible. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const c = (s: string) => classify(s.split(' '))!;

/** A game with exact hands, seat 0 to lead a fresh trick. */
function setup(hands: string[][], patch: Partial<TaiDiGame> = {}): TaiDiGame {
  return {
    numPlayers: hands.length,
    hands: hands.map((h) => [...h]),
    exposed: null,
    unused: 0,
    currentSeat: 0,
    phase: 'play',
    table: null,
    passes: 0,
    mustInclude: null,
    placements: null,
    winner: null,
    log: [],
    seq: 0,
    ...patch,
  };
}

describe('card order', () => {
  it('ranks 2 highest and 3 lowest, with suits ♦ < ♣ < ♥ < ♠', () => {
    expect(cardPower('3D')).toBe(0);
    expect(cardPower('2S')).toBe(51);
    expect(cardPower('2D')).toBeGreaterThan(cardPower('AS'));
    expect(cardPower('3C')).toBeGreaterThan(cardPower('3D'));
    expect(cardPower('3H')).toBeGreaterThan(cardPower('3C'));
    expect(cardPower('3S')).toBeGreaterThan(cardPower('3H'));
  });

  it('sorts a hand low to high', () => {
    expect(sortCards(['2S', '3D', 'AH', '10C'])).toEqual(['3D', '10C', 'AH', '2S']);
  });

  it('has 52 distinct cards', () => {
    expect(new Set(fullDeck()).size).toBe(52);
  });
});

describe('classify', () => {
  it('accepts singles, pairs and triples of one rank', () => {
    expect(c('7H').kind).toBe('single');
    expect(c('7H 7C').kind).toBe('pair');
    expect(c('7H 7C 7S').kind).toBe('triple');
  });

  it('rejects mismatched pairs, triples and sizes of 4, or 6+', () => {
    expect(classify(['7H', '8H'])).toBeNull();
    expect(classify(['7H', '7C', '8S'])).toBeNull();
    expect(classify(['7H', '7C', '7S', '7D'])).toBeNull();
    expect(classify(['3D', '4D', '5D', '6D', '7D', '8D'])).toBeNull();
    expect(classify([])).toBeNull();
    expect(classify(['7H', '7H'])).toBeNull();
  });

  it('recognises each five-card hand', () => {
    expect(c('3D 4C 5H 6S 7D').kind).toBe('straight');
    expect(c('3D 9D JD KD AD').kind).toBe('flush');
    expect(c('5D 5C 5H 9S 9D').kind).toBe('fullhouse');
    expect(c('5D 5C 5H 5S 9D').kind).toBe('quads');
    expect(c('3D 4D 5D 6D 7D').kind).toBe('straightflush');
  });

  it('allows 10-J-Q-K-A but never wraps or uses a 2 in a straight', () => {
    expect(c('10D JC QH KS AD').kind).toBe('straight');
    expect(classify(['JD', 'QC', 'KH', 'AS', '2D'])).toBeNull();
    expect(classify(['AD', '2C', '3H', '4S', '5D'])).toBeNull();
    expect(classify(['2D', '3C', '4H', '5S', '6D'])).toBeNull();
    expect(classify(['QD', 'KC', 'AH', '2S', '3D'])).toBeNull();
  });

  it('rejects unrelated five-card sets', () => {
    expect(classify(['3D', '3C', '5H', '6S', '7D'])).toBeNull();
    expect(classify(['3D', '3C', '3H', '6S', '7D'])).toBeNull();
  });
});

describe('beats', () => {
  it('compares singles by rank then suit', () => {
    expect(beats(c('4D'), c('3S'))).toBe(true);
    expect(beats(c('3S'), c('3H'))).toBe(true);
    expect(beats(c('3H'), c('3S'))).toBe(false);
    expect(beats(c('2D'), c('AS'))).toBe(true);
  });

  it('compares pairs by their top card, so suit breaks a rank tie', () => {
    expect(beats(c('7H 7S'), c('7D 7C'))).toBe(true);
    expect(beats(c('7D 7C'), c('7H 7S'))).toBe(false);
    expect(beats(c('8D 8C'), c('7H 7S'))).toBe(true);
  });

  it('compares triples by rank', () => {
    expect(beats(c('9D 9C 9H'), c('8D 8C 8S'))).toBe(true);
  });

  it('does not let different sizes beat each other', () => {
    expect(beats(c('2S 2H'), c('3D'))).toBe(false);
    expect(beats(c('2S'), c('3D 3C'))).toBe(false);
    expect(beats(c('2S 2H 2C'), c('3D 3C'))).toBe(false);
  });

  it('ranks straight < flush < full house < four of a kind < straight flush', () => {
    const straight = c('3D 4C 5H 6S 7D');
    const flush = c('3D 5D 7D 9D JD');
    const house = c('4D 4C 4H 5S 5D');
    const quads = c('4D 4C 4H 4S 5D');
    const sflush = c('3D 4D 5D 6D 7D');
    expect(beats(flush, straight)).toBe(true);
    expect(beats(house, flush)).toBe(true);
    expect(beats(quads, house)).toBe(true);
    expect(beats(sflush, quads)).toBe(true);
    expect(beats(straight, flush)).toBe(false);
    expect(beats(quads, sflush)).toBe(false);
  });

  it('compares straights by top card, then the top card suit', () => {
    expect(beats(c('4D 5C 6H 7S 8D'), c('3D 4C 5H 6S 7D'))).toBe(true);
    expect(beats(c('3D 4C 5H 6S 7S'), c('3D 4C 5H 6S 7D'))).toBe(true);
    expect(beats(c('3D 4C 5H 6S 7D'), c('3D 4C 5H 6S 7S'))).toBe(false);
  });

  it('compares flushes by suit first, then rank', () => {
    expect(beats(c('3S 4S 5S 6S 8S'), c('3H 9H JH KH AH'))).toBe(true);
    expect(beats(c('3D 5D 7D 9D KD'), c('3D 5D 7D 9D JD'))).toBe(true);
    expect(beats(c('3H 9H JH KH AH'), c('3S 4S 5S 6S 8S'))).toBe(false);
  });

  it('compares full houses by the triple and quads by the four', () => {
    expect(beats(c('6D 6C 6H 3S 3D'), c('5D 5C 5H AS AD'))).toBe(true);
    expect(beats(c('6D 6C 6S 6H 3D'), c('5D 5C 5S 5H AD'))).toBe(true);
  });

  it('compares straight flushes by top card then suit', () => {
    expect(beats(c('4D 5D 6D 7D 8D'), c('3S 4S 5S 6S 7S'))).toBe(true);
    expect(beats(c('3S 4S 5S 6S 7S'), c('3D 4D 5D 6D 7D'))).toBe(true);
  });
});

describe('newGame', () => {
  it('deals 13 each to four players using the whole deck', () => {
    const game = newGame(4, seeded(1));
    expect(game.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    expect(new Set(game.hands.flat()).size).toBe(52);
    expect(game.exposed).toBeNull();
    expect(game.unused).toBe(0);
  });

  it('deals 17 each to three players and gives the exposed card to the 3♦ holder', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const game = newGame(3, seeded(seed));
      const total = game.hands.flat();
      expect(new Set(total).size).toBe(total.length);
      expect(game.exposed).not.toBeNull();
      const lens = game.hands.map((h) => h.length).sort();
      expect(lens).toEqual([17, 17, 18]);
      const holder = game.hands.findIndex((h) => h.includes(game.exposed!));
      expect(game.hands[holder].length).toBe(18);
      // The taker held 3♦ (or 3♣ when 3♦ was the exposed card).
      expect(game.hands[holder].includes(game.exposed === '3D' ? '3C' : '3D')).toBe(true);
    }
  });

  it('deals 17 each to two players and sets 18 aside', () => {
    const game = newGame(2, seeded(3));
    expect(game.hands.map((h) => h.length)).toEqual([17, 17]);
    expect(game.unused).toBe(18);
  });

  it('opens with the holder of the lowest dealt card, who must include it', () => {
    for (const n of [2, 3, 4]) {
      for (let seed = 1; seed <= 25; seed++) {
        const game = newGame(n, seeded(seed * 7 + n));
        const lowest = sortCards(game.hands.flat())[0];
        expect(game.hands[game.currentSeat]).toContain(lowest);
        expect(game.mustInclude).toBe(lowest);
        if (n !== 2) expect(lowest).toBe('3D');
      }
    }
  });

  it('is reproducible from a seed', () => {
    expect(newGame(4, seeded(9)).hands).toEqual(newGame(4, seeded(9)).hands);
  });

  it('rejects a one-player or five-player table', () => {
    expect(() => newGame(1)).toThrow();
    expect(() => newGame(5)).toThrow();
  });
});

describe('play flow', () => {
  it('requires the opening play to include the lowest card', () => {
    const game = setup(
      [['3D', '9H', 'KS'], ['4C', '5C', '6C']],
      { mustInclude: '3D' },
    );
    expect(playCards(game, 0, ['9H'])).toMatch(/must include the 3D/);
    expect(playCards(game, 0, ['3D'])).toBeNull();
    expect(game.mustInclude).toBeNull();
    expect(game.currentSeat).toBe(1);
  });

  it('rejects plays out of turn, with cards not held, or that do not beat the table', () => {
    const game = setup([['4D', '9H', 'KS'], ['5C', '6C', '7C'], ['8C', '9C', '10C']]);
    expect(playCards(game, 1, ['5C'])).toMatch(/not your turn/);
    expect(playCards(game, 0, ['AS'])).toMatch(/don't hold/);
    expect(playCards(game, 0, ['9H'])).toBeNull();
    expect(playCards(game, 1, ['5C'])).toMatch(/doesn't beat/);
    expect(playCards(game, 1, ['5C', '6C'])).toMatch(/valid combination/);
    expect(checkPlay(game, 1, [])).toMatch(/at least one/);
  });

  it('refuses a play of a different size than the table', () => {
    const game = setup([['4D', '9H', '9C'], ['KC', 'KD', 'AS']]);
    expect(playCards(game, 0, ['9H'])).toBeNull();
    expect(playCards(game, 1, ['KC', 'KD'])).toMatch(/Play 1 card/);
  });

  it('does not let the leader pass', () => {
    const game = setup([['4D', '9H'], ['5C', '6C']]);
    expect(pass(game, 0)).toMatch(/must lead/);
  });

  it('ends the trick when everyone else passes and the last player leads again', () => {
    const game = setup([['4D', '9H', 'KS'], ['5C', '6C', '7C'], ['8C', '9C', '10C']]);
    expect(playCards(game, 0, ['9H'])).toBeNull();
    expect(pass(game, 1)).toBeNull();
    expect(game.table).not.toBeNull();
    expect(game.currentSeat).toBe(2);
    expect(pass(game, 2)).toBeNull();
    expect(game.table).toBeNull();
    expect(game.currentSeat).toBe(0);
    expect(game.log.some((l) => l.t === 'trick' && l.seat === 0)).toBe(true);
  });

  it('lets a player who passed play on a later turn', () => {
    const game = setup([['4D', '9H', 'KS'], ['5C', '6C', '10H'], ['8C', '9C', '10C']]);
    playCards(game, 0, ['9H']);
    pass(game, 1);
    expect(playCards(game, 2, ['10C'])).toBeNull();
    expect(game.currentSeat).toBe(0);
    pass(game, 0);
    expect(playCards(game, 1, ['10H'])).toBeNull();
  });

  it('wraps from the last seat to seat 0', () => {
    const game = setup([['4D', '9H', 'KS'], ['5C', '6C'], ['8C', '9C']], { currentSeat: 2 });
    playCards(game, 2, ['8C']);
    expect(game.currentSeat).toBe(0);
  });

  it('ends the game when a hand is emptied and ranks the rest by cards left', () => {
    const game = setup([['KS'], ['3D', '4D', '5D'], ['6D'], ['7D', '8D']]);
    expect(playCards(game, 0, ['KS'])).toBeNull();
    expect(game.phase).toBe('done');
    expect(game.winner).toBe(0);
    expect(game.placements).toEqual([1, 4, 2, 3]);
    expect(playCards(game, 1, ['3D'])).toMatch(/over/);
    expect(pass(game, 1)).toMatch(/over/);
  });

  it('shares a place between players left with the same number of cards', () => {
    const game = setup([['KS'], ['3D', '4D'], ['5D', '6D'], ['7D']]);
    playCards(game, 0, ['KS']);
    expect(placementsFor(game)).toEqual([1, 3, 3, 2]);
  });

  it('caps the log and increments seq', () => {
    const game = setup([['3D', '4D'], ['5C', '6C']]);
    for (let i = 0; i < 100; i++) {
      game.log.push({ t: 'pass', seat: 0, seq: i } as never);
    }
    game.seq = 100;
    playCards(game, 0, ['4D']);
    expect(game.log.length).toBeLessThanOrEqual(61);
    expect(game.seq).toBe(101);
  });
});

describe('full simulated games', () => {
  /** Plays the lowest legal option each turn, passing when nothing beats the table. */
  function autoplay(game: TaiDiGame): number {
    let turns = 0;
    while (game.phase === 'play') {
      if (++turns > 2000) throw new Error('game did not finish');
      const seat = game.currentSeat;
      const hand = game.hands[seat];
      let played = false;
      const tries: string[][] = [];
      for (const a of hand) tries.push([a]);
      for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) tries.push([hand[i], hand[j]]);
      if (game.mustInclude) tries.sort((x, y) => Number(!x.includes(game.mustInclude!)) - Number(!y.includes(game.mustInclude!)));
      for (const cards of tries) {
        if (!checkPlay(game, seat, cards)) {
          expect(playCards(game, seat, cards)).toBeNull();
          played = true;
          break;
        }
      }
      if (!played) expect(pass(game, seat)).toBeNull();
    }
    return turns;
  }

  it.each([2, 3, 4])('plays %i-player games to a finish with a valid result', (n) => {
    for (let seed = 1; seed <= 15; seed++) {
      const game = newGame(n, seeded(seed * 31));
      autoplay(game);
      expect(game.winner).not.toBeNull();
      expect(game.hands[game.winner!]).toHaveLength(0);
      expect(game.placements![game.winner!]).toBe(1);
      expect(game.placements!.filter((p) => p === 1)).toHaveLength(1);
    }
  });
});
