// Tai Di rating: pairwise Elo over the finishing order, for 2–4 players.
// Separate from Bridge's ELO (users.elo) and Regicide's rating — stored in taidi_ratings.

export const START_RATING = 1000;

export interface RatedPlayer {
  telegramId: number;
  rating: number;
  gamesPlayed: number;
}

export interface PlacedPlayer extends RatedPlayer {
  /** 1 = winner; equal places tie. */
  place: number;
}

/** Elo expectation of a player rated `own` against one rated `other`. */
export function expectedScore(own: number, other: number): number {
  return 1 / (1 + Math.pow(10, (other - own) / 400));
}

/**
 * Rating change per player. Every pair of players is a match, won, lost or drawn by finishing place;
 * a player's change is the average result against each opponent, scaled by their own K
 * (32 for a player's first 30 games, then 16, as in elo.ts).
 */
export function computeTaiDiDeltas(players: PlacedPlayer[]): Map<number, number> {
  const deltas = new Map<number, number>();
  if (players.length < 2) return deltas;
  for (const me of players) {
    let sum = 0;
    for (const other of players) {
      if (other === me) continue;
      const score = me.place < other.place ? 1 : me.place === other.place ? 0.5 : 0;
      sum += score - expectedScore(me.rating, other.rating);
    }
    const k = me.gamesPlayed < 30 ? 32 : 16;
    deltas.set(me.telegramId, Math.round((k * sum) / (players.length - 1)));
  }
  return deltas;
}
