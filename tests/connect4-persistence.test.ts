import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  recordConnect4Game,
  getConnect4Leaderboard,
  getConnect4Stats,
  getConnect4GroupLeaderboard,
  type Connect4GameResult,
} from '../src/connect4/db';
import { createConnect4Db } from './connect4-persistence-harness';

type Db = Awaited<ReturnType<typeof createConnect4Db>>['db'];
let worker: Awaited<ReturnType<typeof createConnect4Db>>;
let db: Db;
const TABLES = ['connect4_games', 'connect4_rating_history', 'connect4_ratings', 'connect4_group_stats'];

const win = (gameId: string, overrides: Partial<Connect4GameResult> = {}): Connect4GameResult => ({
  gameId, roomCode: 'TEST', numPlayers: 2,
  players: [
    { telegramId: 1, place: 1, won: true, draw: false },
    { telegramId: 2, place: 2, won: false, draw: false },
  ],
  groupId: '-100', memberIds: [1, 2], ...overrides,
});

const draw = (gameId: string): Connect4GameResult => ({
  gameId, roomCode: 'TEST', numPlayers: 2,
  players: [
    { telegramId: 1, place: 1, won: false, draw: true },
    { telegramId: 2, place: 1, won: false, draw: true },
  ],
  groupId: null, memberIds: [],
});

const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n');

describe('Connect 4 D1 completion transactions (real Miniflare SQLite)', () => {
  beforeAll(async () => {
    worker = await createConnect4Db();
    db = worker.db;
    await db.prepare('CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)').run();
    for (const [id, name] of [[1, 'Ann'], [2, 'Ben'], [3, 'Cat']] as const) {
      await db.prepare('INSERT OR REPLACE INTO users (telegram_id, display_name) VALUES (?, ?)').bind(id, name).run();
    }
  }, 30000);
  afterAll(async () => { await worker?.stop(); });
  beforeEach(async () => {
    for (const table of TABLES) await db.prepare(`DELETE FROM ${table}`).run();
  });

  it('rates a win: winner up, loser down, history and group stats written', async () => {
    const changes = await recordConnect4Game(db, win('g1'));
    expect(changes).toEqual([
      { telegramId: 1, before: 1000, after: 1008, delta: 8 },
      { telegramId: 2, before: 1000, after: 992, delta: -8 },
    ]);
    expect(await db.prepare('SELECT telegram_id, rating, games_played, wins, draws FROM connect4_ratings ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, rating: 1008, games_played: 1, wins: 1, draws: 0 },
      { telegram_id: 2, rating: 992, games_played: 1, wins: 0, draws: 0 },
    ]);
    expect(await db.prepare('SELECT telegram_id, place FROM connect4_rating_history ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, place: 1 }, { telegram_id: 2, place: 2 },
    ]);
    expect(await db.prepare('SELECT telegram_id, games_played, wins, draws FROM connect4_group_stats ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, games_played: 1, wins: 1, draws: 0 },
      { telegram_id: 2, games_played: 1, wins: 0, draws: 0 },
    ]);
    expect(await count('connect4_games')).toBe(1);
  });

  it('keeps existing ratings and applies only a four-point change after 30 rated games', async () => {
    await db.prepare('INSERT INTO connect4_ratings (telegram_id, rating, games_played, updated_at) VALUES (1, 1200, 30, 0), (2, 1200, 30, 0)').run();
    expect(await recordConnect4Game(db, win('experienced'))).toEqual([
      { telegramId: 1, before: 1200, after: 1204, delta: 4 },
      { telegramId: 2, before: 1200, after: 1196, delta: -4 },
    ]);
    expect(await db.prepare('SELECT rating, games_played FROM connect4_ratings ORDER BY telegram_id').all().then(result => result.results)).toEqual([
      { rating: 1204, games_played: 31 }, { rating: 1196, games_played: 31 },
    ]);
  });

  it('rates a draw as 0.5 for both players with no rating change at equal ratings', async () => {
    const changes = await recordConnect4Game(db, draw('draw1'));
    expect(changes).toEqual([
      { telegramId: 1, before: 1000, after: 1000, delta: 0 },
      { telegramId: 2, before: 1000, after: 1000, delta: 0 },
    ]);
    expect(await db.prepare('SELECT telegram_id, rating, draws FROM connect4_ratings ORDER BY telegram_id').all().then((r) => r.results)).toEqual([
      { telegram_id: 1, rating: 1000, draws: 1 },
      { telegram_id: 2, rating: 1000, draws: 1 },
    ]);
  });

  it('is idempotent per game: a repeat changes nothing and reports no new changes', async () => {
    const input = win('repeat');
    expect(await recordConnect4Game(db, input)).toHaveLength(2);
    expect(await recordConnect4Game(db, input)).toEqual([]);
    expect(await db.prepare('SELECT rating, games_played FROM connect4_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1008, games_played: 1 });
    expect(await count('connect4_rating_history')).toBe(2);
    expect(await count('connect4_games')).toBe(1);
  });

  it('accumulates ratings across games', async () => {
    await recordConnect4Game(db, win('a'));
    await recordConnect4Game(db, win('b'));
    expect(await db.prepare('SELECT games_played FROM connect4_ratings WHERE telegram_id = 1').first('games_played')).toBe(2);
    expect(await db.prepare('SELECT rating FROM connect4_ratings WHERE telegram_id = 1').first('rating')).toBeGreaterThan(1008);
  });

  it('rolls back a late group failure and retries the complete game exactly once', async () => {
    const input = win('failed-group', { groupId: '-missing' });
    await expect(recordConnect4Game(db, input)).rejects.toThrow();
    for (const table of TABLES) expect(await count(table)).toBe(0);
    await db.prepare("INSERT INTO groups (group_id) VALUES ('-missing')").run();
    expect(await recordConnect4Game(db, input)).toHaveLength(2);
    expect(await recordConnect4Game(db, input)).toEqual([]);
    expect(await count('connect4_group_stats')).toBe(2);
    expect(await count('connect4_ratings')).toBe(2);
  });

  it('returns leaderboard, stats and group leaderboard shapes', async () => {
    await recordConnect4Game(db, win('lb'));
    const top = await getConnect4Leaderboard(db);
    expect(top.top).toHaveLength(2);
    expect(top.top[0].displayName).toBe('Ann');
    expect(top.top[0].wins).toBe(1);
    expect(top.top[0].draws).toBe(0);
    expect(top.top[0].gamesPlayed).toBe(1);
    const stats = await getConnect4Stats(db);
    expect(stats).toHaveLength(2);
    expect(stats[0].games).toBe(1);
    const group = await getConnect4GroupLeaderboard(db, '-100');
    expect(group).toHaveLength(2);
    expect(group[0].gamesPlayed).toBe(1);
  });
});
