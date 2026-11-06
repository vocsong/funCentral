import type { D1Database } from '@cloudflare/workers-types';
import { computeOmokDeltas, PITY_LOSS_THRESHOLD, START_RATING, type PlacedPlayer } from './rating';

export interface OmokPlayerResult {
  telegramId: number;
  /** 1 = win, 2 = loss; on a draw both players carry place 1. */
  place: number;
  won: boolean;
  draw: boolean;
}

export interface OmokGameResult {
  gameId: string;
  roomCode: string;
  numPlayers: number;
  /** Signed-in players only; guests cannot be seated. */
  players: OmokPlayerResult[];
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
export async function recordOmokGame(db: D1Database, result: OmokGameResult, now = Math.floor(Date.now() / 1000)): Promise<RatingChange[]> {
  const byId = new Map<number, OmokPlayerResult>();
  for (const p of result.players) if (!byId.has(p.telegramId)) byId.set(p.telegramId, p);
  const ids = [...byId.keys()];
  // D1's batch is atomic, but the Elo input read is not part of that batch.
  // Retry a rejected snapshot; persistent contention is retried by the room outbox.
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = ids.length ? await db
      .prepare(`SELECT telegram_id, rating, games_played FROM omok_ratings WHERE telegram_id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ telegram_id: number; rating: number; games_played: number }>() : { results: [] };
    const existing = new Map((rows.results ?? []).map((r) => [r.telegram_id, r]));
    const placed: PlacedPlayer[] = ids.map((id) => ({
      telegramId: id,
      place: byId.get(id)!.place,
      rating: existing.get(id)?.rating ?? START_RATING,
      gamesPlayed: existing.get(id)?.games_played ?? 0,
    }));
    const deltas = computeOmokDeltas(placed);
    const protectedDeltas = computeOmokDeltas(placed, true);
    const loser = placed.find((p) => p.place === 2);
    const winner = placed.find((p) => p.place === 1);
    // Evaluate inside the batch, not in a separate read: simultaneous completions
    // must see the preceding committed result when deciding the fourth loss.
    // Exclude this game so both history inserts and duplicate retries see the
    // same prior streak. The loser's latest rated games define that streak.
    const pityCondition = placed.length === 2 && loser && winner ? `(
      SELECT COUNT(*) = ${PITY_LOSS_THRESHOLD} AND SUM(CASE
        WHEN recent.place = 2 AND EXISTS (
          SELECT 1 FROM omok_rating_history opponent
          WHERE opponent.game_id = recent.game_id AND opponent.telegram_id = ? AND opponent.place = 1
        ) THEN 1 ELSE 0 END) = ${PITY_LOSS_THRESHOLD}
      FROM (
        SELECT game_id, place FROM omok_rating_history
        WHERE telegram_id = ? AND game_id <> ?
        ORDER BY rowid DESC LIMIT ${PITY_LOSS_THRESHOLD}
      ) recent
    )` : '0';
    const pityBindings = placed.length === 2 && loser && winner
      ? [winner.telegramId, loser.telegramId, result.gameId] : [];

    // Accept the first history row only if BOTH players' Elo inputs still match.
    // Every later write is gated on that row, so a stale snapshot makes the entire
    // batch a no-op, including group counters and the completion marker. Pity
    // eligibility remains evaluated inside the accepted transaction.
    const snapshot = placed.map(() => `EXISTS (
      SELECT 1 FROM (SELECT 1) LEFT JOIN omok_ratings r ON r.telegram_id = ?
      WHERE COALESCE(r.rating, ?) = ? AND COALESCE(r.games_played, 0) = ?
    )`).join(' AND ') || '1';
    const snapshotArgs = placed.flatMap((p) => [p.telegramId, START_RATING, p.rating, p.gamesPlayed]);
    const accepted = 'EXISTS (SELECT 1 FROM omok_rating_history WHERE game_id = ? AND telegram_id = ?)';
    const acceptanceArgs = [result.gameId, ids[0] ?? 0];
    const statements = placed.flatMap((p, i) => {
      const delta = deltas.get(p.telegramId) ?? 0;
      const won = byId.get(p.telegramId)!.won ? 1 : 0;
      const draw = byId.get(p.telegramId)!.draw ? 1 : 0;
      return [
        db.prepare(
          `WITH adjustment AS (SELECT CASE WHEN ${pityCondition} THEN ? ELSE ? END AS delta)
           INSERT INTO omok_rating_history (game_id, telegram_id, place, rating_before, rating_after, delta, played_at)
           SELECT ?, ?, ?, COALESCE(r.rating, ?), COALESCE(r.rating, ?) + adjustment.delta, adjustment.delta, ?
           FROM (SELECT 1) LEFT JOIN omok_ratings r ON r.telegram_id = ?
           CROSS JOIN adjustment
           WHERE NOT EXISTS (SELECT 1 FROM omok_games WHERE game_id = ?)
             AND (${i === 0 ? snapshot : accepted})
           RETURNING telegram_id AS telegramId, rating_before AS before, rating_after AS after, delta`,
        ).bind(...pityBindings, protectedDeltas.get(p.telegramId) ?? 0, delta,
          result.gameId, p.telegramId, p.place, START_RATING, START_RATING, now, p.telegramId, result.gameId,
          ...(i === 0 ? snapshotArgs : acceptanceArgs)),
        db.prepare(
          `INSERT INTO omok_ratings (telegram_id, rating, games_played, wins, draws, updated_at)
           SELECT ?, ? + (SELECT delta FROM omok_rating_history WHERE game_id = ? AND telegram_id = ?), 1, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM omok_games WHERE game_id = ?)
             AND ${accepted}
           ON CONFLICT(telegram_id) DO UPDATE SET
             rating = omok_ratings.rating + excluded.rating - ?,
             games_played = games_played + 1,
             wins = wins + excluded.wins,
             draws = draws + excluded.draws,
             updated_at = excluded.updated_at`,
        ).bind(p.telegramId, START_RATING, result.gameId, p.telegramId, won, draw, now, result.gameId, ...acceptanceArgs, START_RATING),
      ];
    });
    if (result.groupId) {
      for (const id of new Set(result.memberIds ?? [])) {
        const res = byId.get(id);
        const won = res?.won ? 1 : 0;
        const draw = res?.draw ? 1 : 0;
        statements.push(db.prepare(
          `INSERT INTO omok_group_stats (group_id, telegram_id, games_played, wins, draws)
           SELECT ?, ?, 1, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM omok_games WHERE game_id = ?)
             AND ${accepted}
           ON CONFLICT(group_id, telegram_id) DO UPDATE SET
             games_played = games_played + 1,
             wins = wins + excluded.wins,
             draws = draws + excluded.draws`,
        ).bind(result.groupId, id, won, draw, result.gameId, ...acceptanceArgs));
      }
    }
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO omok_games (game_id, room_code, num_players, played_at)
       SELECT ?, ?, ?, ? WHERE ${placed.length ? accepted : '1'}`,
    ).bind(result.gameId, result.roomCode, result.numPlayers, now, ...(placed.length ? acceptanceArgs : [])));
    const committed = await db.batch<RatingChange>(statements);
    const changes = placed.flatMap((_, i) => committed[i * 2].results ?? []);
    if (changes.length || await db.prepare('SELECT 1 FROM omok_games WHERE game_id = ?').bind(result.gameId).first()) return changes;
  }
  throw new Error('Omok rating contention; retry completion');
}

export interface OmokLeaderboardEntry {
  rank: number;
  displayName: string;
  elo: number;
  wins: number;
  draws: number;
  gamesPlayed: number;
}

type Row = { telegram_id: number; display_name: string; rating: number; wins: number; draws: number; games_played: number; rank: number };
const toEntry = (r: Row): OmokLeaderboardEntry => ({
  rank: r.rank, displayName: r.display_name, elo: r.rating, wins: r.wins, draws: r.draws, gamesPlayed: r.games_played,
});

/** Same shape as Bridge's getLeaderboard ({ top, me }) so one leaderboard card can render every game. */
export async function getOmokLeaderboard(
  db: D1Database,
  telegramId?: number,
  limit = 5,
): Promise<{ top: OmokLeaderboardEntry[]; me: OmokLeaderboardEntry | null }> {
  const top = await db
    .prepare(
      `SELECT r.telegram_id, u.display_name, r.rating, r.wins, r.draws, r.games_played,
              RANK() OVER (ORDER BY r.rating DESC) AS rank
       FROM omok_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.games_played > 0
       ORDER BY r.rating DESC, r.games_played DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Row>();
  const topRows = top.results ?? [];
  const entries = topRows.map(toEntry);
  if (!telegramId) return { top: entries, me: null };

  const me = await db
    .prepare(
      `SELECT r.telegram_id, u.display_name, r.rating, r.wins, r.draws, r.games_played,
              (SELECT COUNT(*) + 1 FROM omok_ratings o WHERE o.games_played > 0 AND o.rating > r.rating) AS rank
       FROM omok_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.telegram_id = ? AND r.games_played > 0`,
    )
    .bind(telegramId)
    .first<Row>();
  if (!me || topRows.some((r) => r.telegram_id === telegramId)) return { top: entries, me: null };
  return { top: entries, me: toEntry(me) };
}

export interface OmokPlayerStats {
  displayName: string;
  elo: number;
  games: number;
  wins: number;
  draws: number;
  winPct: number;
}

/** Every rated Omok player, for the full stats table. */
export async function getOmokStats(db: D1Database): Promise<OmokPlayerStats[]> {
  const rows = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.games_played, r.wins, r.draws
       FROM omok_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.games_played > 0
       ORDER BY r.rating DESC
       LIMIT 500`,
    )
    .all<{ display_name: string; rating: number; games_played: number; wins: number; draws: number }>();
  return (rows.results ?? []).map((r) => ({
    displayName: r.display_name,
    elo: r.rating,
    games: r.games_played,
    wins: r.wins,
    draws: r.draws,
    winPct: r.games_played ? Math.round((r.wins / r.games_played) * 100) : 0,
  }));
}

export interface OmokGroupEntry {
  displayName: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  draws: number;
}

/** Group members who have played Omok in this group, ranked by their (global) Omok rating. */
export async function getOmokGroupLeaderboard(db: D1Database, groupId: string, limit = 5): Promise<OmokGroupEntry[]> {
  const rows = await db
    .prepare(
      `SELECT u.display_name, COALESCE(r.rating, 1000) AS rating, gs.games_played, gs.wins, gs.draws
       FROM omok_group_stats gs
       JOIN users u ON u.telegram_id = gs.telegram_id
       LEFT JOIN omok_ratings r ON r.telegram_id = gs.telegram_id
       WHERE gs.group_id = ? AND gs.games_played > 0
       ORDER BY rating DESC, gs.games_played DESC
       LIMIT ?`,
    )
    .bind(groupId, limit)
    .all<{ display_name: string; rating: number; games_played: number; wins: number; draws: number }>();
  return (rows.results ?? []).map((r) => ({
    displayName: r.display_name, rating: r.rating, gamesPlayed: r.games_played, wins: r.wins, draws: r.draws,
  }));
}
