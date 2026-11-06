import { describe, it, expect } from 'vitest';
import { computeOmokDeltas, expectedScore, START_RATING } from '../src/omok/rating';

const player = (telegramId: number, place: number, rating = 1000, gamesPlayed = 0) => ({ telegramId, place, rating, gamesPlayed });
const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('omok rating', () => {
  it('starts everyone at 1000 and expects an even match between equals', () => {
    expect(START_RATING).toBe(1000);
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1400, 1000)).toBeGreaterThan(0.9);
  });

  it('two equal new players swing by half of K', () => {
    const d = computeOmokDeltas([player(1, 1), player(2, 2)]);
    expect(d.get(1)).toBe(8);
    expect(d.get(2)).toBe(-8);
    expect(sum(d)).toBe(0);
  });

  it('a draw between equal players changes nothing', () => {
    const d = computeOmokDeltas([player(1, 1), player(2, 1)]);
    expect(d.get(1)).toBe(0);
    expect(d.get(2)).toBe(0);
  });

  it('pays more for beating a stronger opponent, and takes more for losing to a weaker one', () => {
    const upset = computeOmokDeltas([player(1, 1, 1000), player(2, 2, 1400)]);
    const expected = computeOmokDeltas([player(1, 2, 1000), player(2, 1, 1400)]);
    expect(upset.get(1)).toBe(15);
    expect(upset.get(2)).toBe(-15);
    expect(expected.get(1)).toBe(-1);
    expect(expected.get(2)).toBe(1);
  });

  it('uses each player\'s own K=16 for the first 30 games and K=8 after', () => {
    const d = computeOmokDeltas([player(1, 1, 1000, 0), player(2, 2, 1000, 50)]);
    expect(d.get(1)).toBe(8);
    expect(d.get(2)).toBe(-4);
  });

  it.each([[29, 8], [30, 4]])('at %i prior rated games, equal opponents gain/lose %i', (games, change) => {
    const d = computeOmokDeltas([player(1, 1, 1000, games), player(2, 2, 1000, games)]);
    expect(d.get(1)).toBe(change);
    expect(d.get(2)).toBe(-change);
  });

  it('also halves the K-factor for draws against unequal opponents', () => {
    const d = computeOmokDeltas([player(1, 1, 1000), player(2, 1, 1400)]);
    expect(d.get(1)).toBe(7);
    expect(d.get(2)).toBe(-7);
  });

  it.each([[0, 4], [30, 2]])('pity protection halves both K-factors at %i prior games', (games, change) => {
    const d = computeOmokDeltas([player(1, 1, 1000, games), player(2, 2, 1000, games)], true);
    expect(d.get(1)).toBe(change);
    expect(d.get(2)).toBe(-change);
  });

  it('applies protection before rounding and to each player\'s own K', () => {
    const upset = computeOmokDeltas([player(1, 1, 1000), player(2, 2, 1400)], true);
    // Half of the rounded +15 would round to +8; half before rounding is +7.
    expect(upset.get(1)).toBe(7);
    expect(upset.get(2)).toBe(-7);
    const mixed = computeOmokDeltas([player(1, 1), player(2, 2, 1000, 30)], true);
    expect(mixed.get(1)).toBe(4);
    expect(mixed.get(2)).toBe(-2);
  });

  it('returns nothing unless exactly two players are supplied', () => {
    expect(computeOmokDeltas([player(1, 1)]).size).toBe(0);
    expect(computeOmokDeltas([]).size).toBe(0);
    expect(computeOmokDeltas([player(1, 1), player(2, 2), player(3, 2)]).size).toBe(0);
  });
});
