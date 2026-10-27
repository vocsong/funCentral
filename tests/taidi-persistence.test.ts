import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordTaiDiGame, getTaiDiLeaderboard, getTaiDiStats, getTaiDiGroupLeaderboard, type TaiDiGameResult } from '../src/taidi/db';
import { createTaiDiHarness, deferred } from './taidi-persistence-harness';

type Harness = Awaited<ReturnType<typeof createTaiDiHarness>>;
let worker: Harness;
const TABLES = ['taidi_games', 'taidi_rating_history', 'taidi_ratings', 'taidi_group_stats'];

const result = (gameId: string, overrides: Partial<TaiDiGameResult> = {}): TaiDiGameResult => ({
  gameId, roomCode: 'TEST', numPlayers: 2,
  players: [{ telegramId: 1, place: 1 }, { telegramId: 2, place: 2 }],
  groupId: '-100', memberIds: [1, 2], ...overrides,
});
const count = async (table: string) => worker.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n');

// Both calls must finish their SELECT before either can enter its transaction.
// All writes still execute in real local D1/SQLite, not a mock SQL interpreter.
function simultaneousReads(db: Harness['db'], calls = 2) {
  const ready = deferred();
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('SELECT telegram_id, rating, games_played')) return statement;
      return { bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { async all() {
          const rows = await bound.all();
          if (--calls === 0) ready.resolve();
          await ready.promise;
          return rows;
        } };
      } };
    },
    batch: (statements: Parameters<Harness['db']['batch']>[0]) => db.batch(statements),
  } as unknown as Parameters<typeof recordTaiDiGame>[0];
}

describe('Tai Di D1 completion transactions (real Miniflare SQLite)', () => {
  beforeAll(async () => {
    worker = await createTaiDiHarness();
    // Leaderboards join the shared users table.
    await worker.db.prepare('CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)').run();
    for (const [id, name] of [[1, 'Ann'], [2, 'Ben'], [3, 'Cat'], [4, 'Dan']] as const) {
      await worker.db.prepare('INSERT OR REPLACE INTO users (telegram_id, display_name) VALUES (?, ?)').bind(id, name).run();
    }
  }, 30000);
  afterAll(async () => { await worker?.stop(); });
  beforeEach(async () => {
    for (const table of TABLES) await worker.db.prepare(`DELETE FROM ${table}`).run();
  });

  it('rates a two-player game: winner up, loser down, history and group stats written', async () => {
    const changes = await recordTaiDiGame(worker.db as any, result('g1'));
    expect(changes).toEqual([
      { telegramId: 1, before: 1000, after: 1016, delta: 16 },
      { telegramId: 2, before: 1000, after: 984, delta: -16 },
    ]);
    expect(await worker.db.prepare('SELECT telegram_id, rating, games_played, wins FROM taidi_ratings ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, rating: 1016, games_played: 1, wins: 1 },
      { telegram_id: 2, rating: 984, games_played: 1, wins: 0 },
    ]);
    expect(await worker.db.prepare('SELECT telegram_id, place FROM taidi_rating_history ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, place: 1 }, { telegram_id: 2, place: 2 },
    ]);
    expect(await worker.db.prepare('SELECT telegram_id, games_played, wins FROM taidi_group_stats ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, games_played: 1, wins: 1 }, { telegram_id: 2, games_played: 1, wins: 0 },
    ]);
    expect(await count('taidi_games')).toBe(1);
  });

  it('is idempotent per game: a repeat changes nothing and reports no new changes', async () => {
    const input = result('repeat');
    expect(await recordTaiDiGame(worker.db as any, input)).toHaveLength(2);
    expect(await recordTaiDiGame(worker.db as any, input)).toEqual([]);
    expect(await worker.db.prepare('SELECT rating, games_played FROM taidi_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1016, games_played: 1 });
    expect(await count('taidi_rating_history')).toBe(2);
    expect(await count('taidi_games')).toBe(1);
  });

  it('accumulates ratings across games and shares a place on ties', async () => {
    await recordTaiDiGame(worker.db as any, result('a', { numPlayers: 3, players: [{ telegramId: 1, place: 1 }, { telegramId: 2, place: 2 }, { telegramId: 3, place: 2 }], memberIds: [] , groupId: null }));
    const rows = await worker.db.prepare('SELECT telegram_id, rating FROM taidi_ratings ORDER BY telegram_id').all().then((r) => r.results as { telegram_id: number; rating: number }[]);
    expect(rows[1].rating).toBe(rows[2].rating); // tied places move together
    expect(rows[0].rating).toBeGreaterThan(1000);
    await recordTaiDiGame(worker.db as any, result('b', { groupId: null, memberIds: [] }));
    expect(await worker.db.prepare('SELECT games_played FROM taidi_ratings WHERE telegram_id = 1').first('games_played')).toBe(2);
  });

  it('rolls back a late group failure and retries the complete game exactly once', async () => {
    const input = result('failed-group', { groupId: '-missing' });
    await expect(recordTaiDiGame(worker.db as any, input)).rejects.toThrow();
    for (const table of TABLES) expect(await count(table)).toBe(0);
    await worker.db.prepare("INSERT INTO groups (group_id) VALUES ('-missing')").run();
    expect(await recordTaiDiGame(worker.db as any, input)).toHaveLength(2);
    expect(await recordTaiDiGame(worker.db as any, input)).toEqual([]);
    expect(await count('taidi_group_stats')).toBe(2);
    expect(await count('taidi_ratings')).toBe(2);
  });

  it('rolls back earlier player writes when a later history statement fails', async () => {
    await worker.db.prepare(`CREATE TRIGGER fail_second_player BEFORE INSERT ON taidi_rating_history
      WHEN NEW.telegram_id = 2 BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`).run();
    const input = result('failed-history');
    try {
      await expect(recordTaiDiGame(worker.db as any, input)).rejects.toThrow(/injected history failure/);
      for (const table of TABLES) expect(await count(table)).toBe(0);
    } finally {
      await worker.db.prepare('DROP TRIGGER fail_second_player').run();
    }
    expect(await recordTaiDiGame(worker.db as any, input)).toHaveLength(2);
    expect(await count('taidi_rating_history')).toBe(2);
  });

  it('deduplicates overlapping retries including history and group increments', async () => {
    const db = simultaneousReads(worker.db);
    const input = result('duplicate');
    const changes = await Promise.all([recordTaiDiGame(db, input), recordTaiDiGame(db, input)]);
    expect(changes.map((c) => c.length).sort()).toEqual([0, 2]);
    expect(await worker.db.prepare('SELECT rating, games_played, wins FROM taidi_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1016, games_played: 1, wins: 1 });
    expect(await worker.db.prepare('SELECT games_played, wins FROM taidi_group_stats WHERE telegram_id = 1').first()).toEqual({ games_played: 1, wins: 1 });
    expect(await count('taidi_games')).toBe(1);
    expect(await count('taidi_rating_history')).toBe(2);
  });

  it('adds concurrent games\' deltas instead of overwriting a newer rating', async () => {
    const db = simultaneousReads(worker.db);
    // Two different games rate player 1 from the same stale read; both deltas must land.
    await Promise.all([
      recordTaiDiGame(db, result('x', { groupId: null, memberIds: [] })),
      recordTaiDiGame(db, result('y', { groupId: null, memberIds: [] })),
    ]);
    expect(await worker.db.prepare('SELECT rating, games_played FROM taidi_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1032, games_played: 2 });
    expect(await worker.db.prepare('SELECT rating, games_played FROM taidi_ratings WHERE telegram_id = 2').first()).toEqual({ rating: 968, games_played: 2 });
  });

  it('serves the leaderboard, stats table and group board', async () => {
    await recordTaiDiGame(worker.db as any, result('lb'));
    const board = await getTaiDiLeaderboard(worker.db as any, 2, 1);
    expect(board.top).toEqual([{ rank: 1, displayName: 'Ann', elo: 1016, wins: 1, gamesPlayed: 1 }]);
    expect(board.me).toEqual({ rank: 2, displayName: 'Ben', elo: 984, wins: 0, gamesPlayed: 1 });
    expect((await getTaiDiLeaderboard(worker.db as any, 1, 1)).me).toBeNull(); // already in the top
    const stats = await getTaiDiStats(worker.db as any);
    expect(stats.map((s) => [s.displayName, s.elo, s.winPct, s.avgPlace])).toEqual([['Ann', 1016, 100, 1], ['Ben', 984, 0, 2]]);
    const group = await getTaiDiGroupLeaderboard(worker.db as any, '-100');
    expect(group.map((g) => [g.displayName, g.rating, g.wins])).toEqual([['Ann', 1016, 1], ['Ben', 984, 0]]);
  });
});
