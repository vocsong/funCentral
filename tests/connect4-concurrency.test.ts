// Deterministic fault injection on real local D1/SQLite, not mocked Elo arithmetic.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { recordConnect4Game, type Connect4GameResult } from '../src/connect4/db';
import { createConnect4Db } from './connect4-persistence-harness';

type Harness = Awaited<ReturnType<typeof createConnect4Db>>;
let actual: Harness, oracle: Harness;
const tables = ['connect4_games', 'connect4_rating_history', 'connect4_ratings', 'connect4_group_stats'];
const win = (gameId: string, winner = 1, loser = 2): Connect4GameResult => ({
  gameId, roomCode: gameId, numPlayers: 2, groupId: '-100', memberIds: [winner, loser],
  players: [
    { telegramId: winner, place: 1, won: true, draw: false },
    { telegramId: loser, place: 2, won: false, draw: false },
  ],
});
const complete = (db: D1Database, result: Connect4GameResult) => recordConnect4Game(db, result, 100);
async function snapshot(db: D1Database) {
  const output: Record<string, unknown> = {};
  for (const table of tables) output[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results;
  return output;
}
async function seed(db: D1Database, games = 29) {
  for (let id = 1; id <= 5; id++) await db.prepare(
    'INSERT INTO connect4_ratings (telegram_id, rating, games_played, updated_at) VALUES (?, 1000, ?, 0)',
  ).bind(id, games).run();
}
function barrier(db: D1Database) {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return {
    prepare: db.prepare.bind(db),
    async batch(statements: Parameters<D1Database['batch']>[0]) {
      if (++arrivals <= 2) {
        if (arrivals === 2) release();
        await ready;
      }
      return db.batch(statements);
    },
    get arrivals() { return arrivals; },
  } as unknown as D1Database & { arrivals: number };
}

describe('Connect 4 cross-room concurrency and retry chaos (real D1)', () => {
  beforeAll(async () => { actual = await createConnect4Db(); oracle = await createConnect4Db(); }, 30000);
  afterAll(async () => { await actual?.stop(); await oracle?.stop(); });
  beforeEach(async () => {
    for (const db of [actual.db, oracle.db]) for (const table of tables) await db.prepare(`DELETE FROM ${table}`).run();
  });

  it.each(['new players', 'K-factor boundary', 'shared player second', 'draw changes game count'])('%s: overlapping old snapshots equal a valid sequential execution', async (scenario) => {
    if (scenario !== 'new players') for (const db of [actual.db, oracle.db]) await seed(db);
    const a = win('AAAA');
    const b = scenario === 'shared player second' ? win('BBBB', 3, 1) : win('BBBB', 1, 3);
    if (scenario === 'draw changes game count') a.players = a.players.map((p) => ({ ...p, place: 1, won: false, draw: true }));
    const racing = barrier(actual.db as unknown as D1Database);
    expect((await Promise.all([complete(racing, a), complete(racing, b)])).map((r) => r.length)).toEqual([2, 2]);
    expect(racing.arrivals).toBe(3); // a stale transaction must re-read and recompute
    const order = (await actual.db.prepare('SELECT game_id FROM connect4_games ORDER BY rowid').all<{ game_id: string }>()).results;
    for (const row of order) await complete(oracle.db as unknown as D1Database, [a, b].find((r) => r.gameId === row.game_id)!);
    expect(await snapshot(actual.db as unknown as D1Database)).toEqual(await snapshot(oracle.db as unknown as D1Database));
    if (scenario === 'K-factor boundary') expect(await actual.db.prepare('SELECT rating, games_played FROM connect4_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1012, games_played: 31 });
  });

  it('contention exhaustion commits nothing and remains retryable', async () => {
    await seed(actual.db as unknown as D1Database);
    const db = actual.db;
    let attempts = 0;
    const alwaysStale = {
      prepare: db.prepare.bind(db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        attempts++;
        // Another room completed a game after each input read, even at unchanged Elo.
        await db.prepare('UPDATE connect4_ratings SET games_played = games_played + 1 WHERE telegram_id = 2').run();
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(complete(alwaysStale, win('retry-later'))).rejects.toThrow('contention');
    expect(attempts).toBe(5);
    for (const table of ['connect4_games', 'connect4_rating_history', 'connect4_group_stats']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
    expect(await db.prepare('SELECT rating, games_played FROM connect4_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1000, games_played: 29 });
    expect(await complete(db as unknown as D1Database, win('retry-later'))).toHaveLength(2);
  });

  it('duplicate/reordered completions, late rollback and lost acknowledgements converge to sequential history', async () => {
    for (const db of [actual.db, oracle.db]) await seed(db as unknown as D1Database, 27);
    const inputs = Array.from({ length: 12 }, (_, i) => win(`chaos-${i}`, i % 3 === 0 ? 2 + i % 4 : 1, i % 3 === 0 ? 1 : 2 + i % 4));
    // A failure at the LAST statement must roll back history, rating and group writes.
    await actual.db.prepare("CREATE TRIGGER fail_completion BEFORE INSERT ON connect4_games WHEN NEW.game_id = 'chaos-0' BEGIN SELECT RAISE(ABORT, 'injected late completion failure'); END").run();
    await expect(complete(actual.db as unknown as D1Database, inputs[0])).rejects.toThrow('injected');
    expect(await actual.db.prepare('SELECT COUNT(*) AS n FROM connect4_rating_history').first('n')).toBe(0);
    await actual.db.prepare('DROP TRIGGER fail_completion').run();
    let lost = false;
    const lossy = {
      prepare: actual.db.prepare.bind(actual.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        const result = await actual.db.batch(statements);
        if (!lost) { lost = true; throw new Error('injected lost acknowledgement AFTER commit'); }
        return result;
      },
    } as unknown as D1Database;
    for (let wave = 0; wave < 4; wave++) {
      const batch = inputs.slice(wave * 3, wave * 3 + 3).reverse();
      const attempts = [...batch, batch[0]];
      const settled = await Promise.allSettled(attempts.map((result) => complete(lossy, result)));
      for (let i = 0; i < settled.length; i++) if (settled[i].status === 'rejected') await complete(actual.db as unknown as D1Database, attempts[i]);
    }
    expect(lost).toBe(true);
    const order = (await actual.db.prepare('SELECT game_id FROM connect4_games ORDER BY rowid').all<{ game_id: string }>()).results;
    expect(order).toHaveLength(12);
    for (const row of order) await complete(oracle.db as unknown as D1Database, inputs.find((r) => r.gameId === row.game_id)!);
    expect(await snapshot(actual.db as unknown as D1Database)).toEqual(await snapshot(oracle.db as unknown as D1Database));
    for (const result of inputs.reverse()) expect(await complete(actual.db as unknown as D1Database, result)).toEqual([]);
    expect(await snapshot(actual.db as unknown as D1Database)).toEqual(await snapshot(oracle.db as unknown as D1Database));
  });
});
