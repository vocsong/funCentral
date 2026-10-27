import type { D1Database } from '@cloudflare/workers-types';
import { computeTaiDiDeltas, START_RATING, type PlacedPlayer } from './rating';

export interface TaiDiPlayerResult {
  telegramId: number;
  /** 1 = winner; equal places tie. */
  place: number;
}

export interface TaiDiGameResult {
  gameId: string;
  roomCode: string;
  numPlayers: number;
  /** Signed-in players only; guests cannot be seated. */
  players: TaiDiPlayerResult[];
  /** Verified group members, committed atomically with the global result. */
  groupId?: string | null;
  memberIds?: number[];
}

export interface RatingChange {
  telegramId: number;
  before: number;
  after: number;
  delta: number;
}

/**
 * Rates a finished game for every signed-in player and records it.
 * Idempotent per gameId: a second call for the same game changes nothing and returns [].
 */
export async function recordTaiDiGame(db: D1Database, result: TaiDiGameResult, now = Math.floor(Date.now() / 1000)): Promise<RatingChange[]> {
  const byId = new Map<number, TaiDiPlayerResult>();
  for (const p of result.players) if (!byId.has(p.telegramId)) byId.set(p.telegramId, p);
  const ids = [...byId.keys()];
  const rows = ids.length ? await db
    .prepare(`SELECT telegram_id, rating, games_played FROM taidi_ratings WHERE telegram_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ telegram_id: number; rating: number; games_played: number }>() : { results: [] };
  const existing = new Map((rows.results ?? []).map((r) => [r.telegram_id, r]));
  const placed: PlacedPlayer[] = ids.map((id) => ({
    telegramId: id,
    place: byId.get(id)!.place,
    rating: existing.get(id)?.rating ?? START_RATING,
    gamesPlayed: existing.get(id)?.games_played ?? 0,
  }));
  const deltas = computeTaiDiDeltas(placed);

  // D1 batches are transactions. Gate every write on the completion marker and
  // insert that marker LAST, so failures roll back and concurrent retries are no-ops.
  // Deltas may use the earlier read, but history and arithmetic use the rating
  // actually present in this transaction (another room may have just rated it).
  const statements = placed.flatMap((p) => {
    const delta = deltas.get(p.telegramId) ?? 0;
    const won = p.place === 1 ? 1 : 0;
    return [
      db.prepare(
        `INSERT INTO taidi_rating_history (game_id, telegram_id, place, rating_before, rating_after, delta, played_at)
         SELECT ?, ?, ?, COALESCE(r.rating, ?), COALESCE(r.rating, ?) + ?, ?, ?
         FROM (SELECT 1) LEFT JOIN taidi_ratings r ON r.telegram_id = ?
         WHERE NOT EXISTS (SELECT 1 FROM taidi_games WHERE game_id = ?)
         RETURNING telegram_id AS telegramId, rating_before AS before, rating_after AS after, delta`,
      ).bind(result.gameId, p.telegramId, p.place, START_RATING, START_RATING, delta, delta, now, p.telegramId, result.gameId),
      db.prepare(
        `INSERT INTO taidi_ratings (telegram_id, rating, games_played, wins, updated_at)
         SELECT ?, ?, 1, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM taidi_games WHERE game_id = ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           rating = taidi_ratings.rating + ?,
           games_played = games_played + 1,
           wins = wins + excluded.wins,
           updated_at = excluded.updated_at`,
      ).bind(p.telegramId, START_RATING + delta, won, now, result.gameId, delta),
    ];
  });
  if (result.groupId) {
    for (const id of new Set(result.memberIds ?? [])) {
      const won = byId.get(id)?.place === 1 ? 1 : 0;
      statements.push(db.prepare(
        `INSERT INTO taidi_group_stats (group_id, telegram_id, games_played, wins)
         SELECT ?, ?, 1, ?
         WHERE NOT EXISTS (SELECT 1 FROM taidi_games WHERE game_id = ?)
         ON CONFLICT(group_id, telegram_id) DO UPDATE SET
           games_played = games_played + 1,
           wins = wins + excluded.wins`,
      ).bind(result.groupId, id, won, result.gameId));
    }
  }
  statements.push(db.prepare(
    `INSERT OR IGNORE INTO taidi_games (game_id, room_code, num_players, played_at) VALUES (?, ?, ?, ?)`,
  ).bind(result.gameId, result.roomCode, result.numPlayers, now));
  const committed = await db.batch<RatingChange>(statements);
  return placed.flatMap((_, i) => committed[i * 2].results ?? []);
}

export interface TaiDiLeaderboardEntry {
  rank: number;
  displayName: string;
  elo: number;
  wins: number;
  gamesPlayed: number;
}

type Row = { display_name: string; rating: number; wins: number; games_played: number; rank: number };
const toEntry = (r: Row): TaiDiLeaderboardEntry => ({
  rank: r.rank, displayName: r.display_name, elo: r.rating, wins: r.wins, gamesPlayed: r.games_played,
});

/** Same shape as Bridge's getLeaderboard ({ top, me }) so one leaderboard card can render every game. */
export async function getTaiDiLeaderboard(
  db: D1Database,
  telegramId?: number,
  limit = 5,
): Promise<{ top: TaiDiLeaderboardEntry[]; me: TaiDiLeaderboardEntry | null }> {
  const top = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.wins, r.games_played,
              RANK() OVER (ORDER BY r.rating DESC) AS rank
       FROM taidi_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.games_played > 0
       ORDER BY r.rating DESC, r.games_played DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Row>();
  const entries = (top.results ?? []).map(toEntry);
  if (!telegramId) return { top: entries, me: null };

  const me = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.wins, r.games_played,
              (SELECT COUNT(*) + 1 FROM taidi_ratings o WHERE o.games_played > 0 AND o.rating > r.rating) AS rank
       FROM taidi_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.telegram_id = ? AND r.games_played > 0`,
    )
    .bind(telegramId)
    .first<Row>();
  if (!me || me.rank <= limit) return { top: entries, me: null };
  return { top: entries, me: toEntry(me) };
}

export interface TaiDiPlayerStats {
  displayName: string;
  elo: number;
  games: number;
  wins: number;
  winPct: number;
  /** Mean finishing place per rated game, one decimal. */
  avgPlace: number;
}

/** Every rated Tai Di player, for the full stats table (the client filters by min games, like Bridge). */
export async function getTaiDiStats(db: D1Database): Promise<TaiDiPlayerStats[]> {
  const rows = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.games_played, r.wins,
              (SELECT ROUND(AVG(h.place), 1) FROM taidi_rating_history h WHERE h.telegram_id = r.telegram_id) AS avg_place
       FROM taidi_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.games_played > 0
       ORDER BY r.rating DESC
       LIMIT 500`,
    )
    .all<{ display_name: string; rating: number; games_played: number; wins: number; avg_place: number | null }>();
  return (rows.results ?? []).map((r) => ({
    displayName: r.display_name,
    elo: r.rating,
    games: r.games_played,
    wins: r.wins,
    winPct: r.games_played ? Math.round((r.wins / r.games_played) * 100) : 0,
    avgPlace: r.avg_place ?? 0,
  }));
}

export interface TaiDiGroupEntry {
  displayName: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
}

/** Group members who have played Tai Di in this group, ranked by their (global) Tai Di rating — as Bridge's group board ranks by ELO. */
export async function getTaiDiGroupLeaderboard(db: D1Database, groupId: string, limit = 5): Promise<TaiDiGroupEntry[]> {
  const rows = await db
    .prepare(
      `SELECT u.display_name, COALESCE(r.rating, 1000) AS rating, gs.games_played, gs.wins
       FROM taidi_group_stats gs
       JOIN users u ON u.telegram_id = gs.telegram_id
       LEFT JOIN taidi_ratings r ON r.telegram_id = gs.telegram_id
       WHERE gs.group_id = ? AND gs.games_played > 0
       ORDER BY rating DESC, gs.games_played DESC
       LIMIT ?`,
    )
    .bind(groupId, limit)
    .all<{ display_name: string; rating: number; games_played: number; wins: number }>();
  return (rows.results ?? []).map((r) => ({
    displayName: r.display_name, rating: r.rating, gamesPlayed: r.games_played, wins: r.wins,
  }));
}
