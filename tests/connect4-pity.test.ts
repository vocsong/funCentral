// Real local D1 transactions: pity eligibility is decided inside the completion batch.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { recordConnect4Game, type Connect4GameResult } from '../src/connect4/db';
import { computeConnect4Deltas } from '../src/connect4/rating';
import { createConnect4Db } from './connect4-persistence-harness';

type Harness = Awaited<ReturnType<typeof createConnect4Db>>;
let worker: Harness;
let db: Harness['db'];
const tables = ['connect4_games', 'connect4_rating_history', 'connect4_ratings', 'connect4_group_stats'];
const win = (gameId: string, winner = 1, loser = 2): Connect4GameResult => ({
  gameId, roomCode: 'PITY', numPlayers: 2,
  players: [
    { telegramId: winner, place: 1, won: true, draw: false },
    { telegramId: loser, place: 2, won: false, draw: false },
  ],
});
// Fixed timestamps intentionally exercise deterministic ordering of same-second games.
const complete = (result: Connect4GameResult) => recordConnect4Game(db, result, 100);
const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n');
const ratings = () => db.prepare('SELECT telegram_id, rating, games_played FROM connect4_ratings ORDER BY telegram_id').all().then(result => result.results);
async function expected(result: Connect4GameResult, protectedMatch: boolean) {
  const rows = await ratings();
  const players = result.players.map(player => {
    const row = rows.find(row => row.telegram_id === player.telegramId);
    return { ...player, rating: Number(row?.rating ?? 1000), gamesPlayed: Number(row?.games_played ?? 0) };
  });
  const deltas = computeConnect4Deltas(players, protectedMatch);
  return result.players.map(player => deltas.get(player.telegramId));
}
async function losses(n = 3) {
  for (let i = 1; i <= n; i++) await complete(win(`loss-${i}`));
}

describe('Connect 4 repeated-opponent protection (real D1)', () => {
  beforeAll(async () => { worker = await createConnect4Db(); db = worker.db; }, 30000);
  afterAll(async () => { await worker?.stop(); });
  beforeEach(async () => { for (const table of tables) await db.prepare(`DELETE FROM ${table}`).run(); });

  it('starts on the fourth consecutive loss, halves both changes and continues across rooms', async () => {
    for (let i = 1; i <= 3; i++) {
      const result = win(`loss-${i}`);
      const full = await expected(result, false);
      expect((await complete(result)).map(change => change.delta)).toEqual(full);
    }
    for (let i = 4; i <= 5; i++) {
      const result = { ...win(`loss-${i}`), roomCode: 'NEXT' };
      const half = await expected(result, true);
      expect((await complete(result)).map(change => change.delta)).toEqual(half);
    }
    expect(await count('connect4_games')).toBe(5);
    expect(await count('connect4_rating_history')).toBe(10);
  });

  it.each(['win', 'draw', 'another opponent'])('a rated %s breaks the losing player\'s streak', async kind => {
    await losses();
    const breaker = kind === 'win' ? win('break', 2, 1)
      : kind === 'another opponent' ? win('break', 3, 2)
      : { ...win('break'), players: [1, 2].map(telegramId => ({ telegramId, place: 1, won: false, draw: true })) };
    const fullBreak = await expected(breaker, false);
    expect((await complete(breaker)).map(change => change.delta)).toEqual(fullBreak);
    const next = win('after-break');
    const full = await expected(next, false);
    expect((await complete(next)).map(change => change.delta)).toEqual(full);
  });

  it('uses committed history order even if the wall clock moves backwards', async () => {
    await losses();
    await recordConnect4Game(db, win('clock-break', 3, 2), 50);
    const next = win('after-clock-break');
    const full = await expected(next, false);
    expect((await complete(next)).map(change => change.delta)).toEqual(full);
  });

  it('does not break the loser streak when only the winner plays somebody else', async () => {
    await losses();
    await complete(win('winner-other-match', 1, 3));
    const next = win('fourth-loss');
    const half = await expected(next, true);
    expect((await complete(next)).map(change => change.delta)).toEqual(half);
  });

  it('uses the same protection when the losing player history is inserted first', async () => {
    await losses();
    const next = win('loser-first');
    next.players.reverse();
    const half = await expected(next, true);
    const changes = await complete(next);
    expect(changes.map(change => change.delta)).toEqual(half);
    expect(changes[0].delta).toBeLessThan(0);
    expect(changes[1].delta).toBeGreaterThan(0);
    for (const change of changes) expect(change.after - change.before).toBe(change.delta);
  });

  it('duplicate retries neither apply protection twice nor add extra streak results', async () => {
    await losses();
    const result = win('duplicate-fourth');
    const half = await expected(result, true);
    const attempts = await Promise.all([complete(result), complete(result)]);
    expect(attempts.map(changes => changes.length).sort()).toEqual([0, 2]);
    expect(attempts.flat().map(change => change.delta)).toEqual(half);
    const before = await ratings();
    expect(await complete(result)).toEqual([]);
    expect(await ratings()).toEqual(before);
    expect(await count('connect4_games')).toBe(4);
    expect(await count('connect4_rating_history')).toBe(8);
  });

  it('rolls back a protected result on a late failure, then retries exactly once', async () => {
    await losses();
    const before = await ratings();
    const result = { ...win('failed-fourth'), groupId: '-missing', memberIds: [1, 2] };
    const half = await expected(result, true);
    await expect(complete(result)).rejects.toThrow();
    expect(await ratings()).toEqual(before);
    expect(await count('connect4_games')).toBe(3);
    expect(await count('connect4_rating_history')).toBe(6);
    await db.prepare("INSERT INTO groups (group_id) VALUES ('-missing')").run();
    expect((await complete(result)).map(change => change.delta)).toEqual(half);
    expect(await complete(result)).toEqual([]);
  });

  it('concurrent distinct results crossing the threshold protect only the fourth loss', async () => {
    await losses(2);
    const full = await expected(win('third'), false);
    // The fourth loss must use the ratings AFTER the third, not the shared
    // pre-transaction snapshot. Rounding can make its protected delta differ.
    const before = await ratings();
    const halfMap = computeConnect4Deltas(win('fourth').players.map((player, i) => ({
      ...player,
      rating: Number(before.find((r) => r.telegram_id === player.telegramId)!.rating) + full[i]!,
      gamesPlayed: Number(before.find((r) => r.telegram_id === player.telegramId)!.games_played) + 1,
    })), true);
    const half = win('fourth').players.map((p) => halfMap.get(p.telegramId));
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    // Hold both batches until both callers have taken their rating snapshots.
    // Eligibility still has to see the preceding transaction, not that snapshot.
    const gated = {
      prepare: db.prepare.bind(db),
      batch: async (statements: Parameters<typeof db.batch>[0]) => {
        if (++arrivals === 2) release();
        await ready;
        return db.batch(statements);
      },
    } as unknown as D1Database;
    const results = await Promise.all([
      recordConnect4Game(gated, win('concurrent-a'), 100),
      recordConnect4Game(gated, win('concurrent-b'), 100),
    ]);
    expect(results.map(changes => changes[0].delta).sort()).toEqual([full[0], half[0]].sort());
    expect(results.map(changes => changes[1].delta).sort()).toEqual([full[1], half[1]].sort());
    expect(await count('connect4_games')).toBe(4);
    expect(await count('connect4_rating_history')).toBe(8);
    expect((await ratings()).map(row => row.games_played)).toEqual([4, 4]);
  });
});
