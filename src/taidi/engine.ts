// Pure Tai Di (Big Two) rules engine, 2–4 players. No Cloudflare dependencies.
//
// Card codes: rank + suit letter, e.g. '3D', '10H', 'AS', '2S'.
// Rank order, low to high: 3 4 5 6 7 8 9 10 J Q K A 2. Suit order, low to high: D C H S.
// Seats play in ascending order and wrap.

export type Suit = 'D' | 'C' | 'H' | 'S';
export const SUITS: Suit[] = ['D', 'C', 'H', 'S'];
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export type Phase = 'play' | 'done';

/**
 * Combination kinds. Five-card hands rank straight < flush < full house < four of a kind
 * (+1 odd card) < straight flush; everything else only beats the same kind.
 */
export type ComboKind = 'single' | 'pair' | 'triple' | 'straight' | 'flush' | 'fullhouse' | 'quads' | 'straightflush';

export interface Combo {
  kind: ComboKind;
  size: number;
  /** Five-card tier (1 straight … 5 straight flush); 0 for single/pair/triple. */
  tier: number;
  /** Tie-break within the same kind. */
  power: number;
}

export interface TablePlay extends Combo {
  seat: number;
  cards: string[];
}

export type LogEntry = { seq: number } & (
  | { t: 'play'; seat: number; cards: string[]; kind: ComboKind }
  | { t: 'pass'; seat: number }
  | { t: 'trick'; seat: number }
  | { t: 'won'; seat: number }
);
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type LogInput = DistributiveOmit<LogEntry, 'seq'>;

export interface TaiDiGame {
  numPlayers: number;
  hands: string[][];
  /** Cards dealt face up to the table before play (3 players only), else null. */
  exposed: string | null;
  /** Cards left out of the deal (2 players only). */
  unused: number;
  currentSeat: number;
  phase: Phase;
  /** The play to beat, or null when the current seat leads a fresh trick. */
  table: TablePlay | null;
  /** Consecutive passes since the last play. */
  passes: number;
  /** The opening play must include this card (the lowest dealt); cleared once played. */
  mustInclude: string | null;
  /** Per seat after the game ends: 1 for the winner, then by fewest cards left (ties share a place). */
  placements: number[] | null;
  winner: number | null;
  log: LogEntry[];
  seq: number;
}

export type Rng = () => number;

const LOG_LIMIT = 60;
const DEAL: Record<number, number> = { 2: 17, 3: 17, 4: 13 };

export function cardRank(card: string): string {
  return card.slice(0, -1);
}

export function cardSuit(card: string): Suit {
  return card.slice(-1) as Suit;
}

/** Index of the rank in Tai Di order (3 = 0 … 2 = 12). */
export function rankIndex(card: string): number {
  return RANKS.indexOf(cardRank(card));
}

/** Total order over all 52 cards: rank first, then suit. */
export function cardPower(card: string): number {
  return rankIndex(card) * 4 + SUITS.indexOf(cardSuit(card));
}

export function sortCards(cards: string[]): string[] {
  return [...cards].sort((a, b) => cardPower(a) - cardPower(b));
}

export function fullDeck(): string[] {
  const deck: string[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

export function shuffle<T>(arr: T[], rng: Rng = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Classifies a set of cards, or returns null when it is not a legal combination. */
export function classify(cards: string[]): Combo | null {
  const n = cards.length;
  if (new Set(cards).size !== n) return null;
  const sorted = sortCards(cards);
  const top = sorted[n - 1];

  if (n === 1) return { kind: 'single', size: 1, tier: 0, power: cardPower(top) };
  if (n === 2) {
    return rankIndex(sorted[0]) === rankIndex(sorted[1]) ? { kind: 'pair', size: 2, tier: 0, power: cardPower(top) } : null;
  }
  if (n === 3) {
    return sorted.every((c) => rankIndex(c) === rankIndex(top)) ? { kind: 'triple', size: 3, tier: 0, power: rankIndex(top) } : null;
  }
  if (n !== 5) return null;

  const counts = new Map<number, number>();
  for (const c of sorted) counts.set(rankIndex(c), (counts.get(rankIndex(c)) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const flush = sorted.every((c) => cardSuit(c) === cardSuit(top));
  const ranks = sorted.map(rankIndex);
  // Straights are five consecutive ranks from 3 up to A; 2s never join a straight and nothing wraps.
  const straight = counts.size === 5 && ranks[4] <= RANKS.indexOf('A') && ranks[4] - ranks[0] === 4;

  if (straight && flush) return { kind: 'straightflush', size: 5, tier: 5, power: cardPower(top) };
  if (groups[0][1] === 4) return { kind: 'quads', size: 5, tier: 4, power: groups[0][0] };
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) return { kind: 'fullhouse', size: 5, tier: 3, power: groups[0][0] };
  if (flush) return { kind: 'flush', size: 5, tier: 2, power: SUITS.indexOf(cardSuit(top)) * 16 + rankIndex(top) };
  if (straight) return { kind: 'straight', size: 5, tier: 1, power: cardPower(top) };
  return null;
}

/** Whether `a` beats `b`. Only the same size can be compared; a stronger five-card tier wins outright. */
export function beats(a: Combo, b: Combo): boolean {
  if (a.size !== b.size) return false;
  if (a.size === 5) return a.tier !== b.tier ? a.tier > b.tier : a.power > b.power;
  return a.power > b.power;
}

export function nextSeat(game: TaiDiGame, seat: number): number {
  return (seat + 1) % game.numPlayers;
}

function addLog(game: TaiDiGame, entry: LogInput): void {
  game.seq += 1;
  game.log.push({ ...entry, seq: game.seq } as LogEntry);
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

export function newGame(numPlayers: number, rng: Rng = Math.random): TaiDiGame {
  if (numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) throw new Error('Tai Di supports 2–4 players');
  const deck = shuffle(fullDeck(), rng);
  const per = DEAL[numPlayers];
  const hands: string[][] = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < per; i++) for (const hand of hands) hand.push(deck.shift()!);

  let exposed: string | null = null;
  let unused = 0;
  if (numPlayers === 3) {
    // The leftover card is dealt face up and goes to the 3♦ holder (the 3♣ holder if it is the 3♦ itself).
    exposed = deck.shift()!;
    const taker = exposed === '3D' ? '3C' : '3D';
    hands.find((h) => h.includes(taker))!.push(exposed);
  } else {
    unused = deck.length;
  }
  for (let i = 0; i < hands.length; i++) hands[i] = sortCards(hands[i]);

  // The holder of the lowest card in play opens, and must include it.
  let lowest = hands[0][0];
  let opener = 0;
  hands.forEach((h, seat) => {
    if (cardPower(h[0]) < cardPower(lowest)) {
      lowest = h[0];
      opener = seat;
    }
  });

  return {
    numPlayers,
    hands,
    exposed,
    unused,
    currentSeat: opener,
    phase: 'play',
    table: null,
    passes: 0,
    mustInclude: lowest,
    placements: null,
    winner: null,
    log: [],
    seq: 0,
  };
}

function guardTurn(game: TaiDiGame, seat: number): string | null {
  if (game.phase !== 'play') return 'The game is over';
  if (seat !== game.currentSeat) return "It's not your turn";
  return null;
}

/** Why `cards` cannot be played by `seat` right now, or null when the play is legal. */
export function checkPlay(game: TaiDiGame, seat: number, cards: string[]): string | null {
  const turn = guardTurn(game, seat);
  if (turn) return turn;
  if (cards.length === 0) return 'Pick at least one card';
  const hand = game.hands[seat];
  if (new Set(cards).size !== cards.length) return 'Duplicate cards';
  if (!cards.every((c) => hand.includes(c))) return "You don't hold those cards";
  const combo = classify(cards);
  if (!combo) return "That isn't a valid combination";
  if (game.mustInclude && !cards.includes(game.mustInclude)) return `The first play must include the ${game.mustInclude}`;
  if (game.table && !beats(combo, game.table)) {
    return game.table.size === combo.size ? "That doesn't beat the cards on the table" : `Play ${game.table.size} card${game.table.size === 1 ? '' : 's'} to beat the table`;
  }
  return null;
}

export function playCards(game: TaiDiGame, seat: number, cards: string[]): string | null {
  const error = checkPlay(game, seat, cards);
  if (error) return error;
  const combo = classify(cards)!;
  const played = sortCards(cards);
  game.hands[seat] = game.hands[seat].filter((c) => !cards.includes(c));
  game.table = { ...combo, seat, cards: played };
  game.passes = 0;
  game.mustInclude = null;
  addLog(game, { t: 'play', seat, cards: played, kind: combo.kind });

  if (game.hands[seat].length === 0) {
    game.phase = 'done';
    game.winner = seat;
    game.placements = placementsFor(game);
    addLog(game, { t: 'won', seat });
    return null;
  }
  game.currentSeat = nextSeat(game, seat);
  return null;
}

export function pass(game: TaiDiGame, seat: number): string | null {
  const turn = guardTurn(game, seat);
  if (turn) return turn;
  if (!game.table) return 'You must lead — you cannot pass';
  addLog(game, { t: 'pass', seat });
  game.passes += 1;
  if (game.passes >= game.numPlayers - 1) {
    // Everyone else passed in a row: the last player to play takes the trick and leads.
    const leader = game.table.seat;
    game.table = null;
    game.passes = 0;
    game.currentSeat = leader;
    addLog(game, { t: 'trick', seat: leader });
    return null;
  }
  game.currentSeat = nextSeat(game, seat);
  return null;
}

/** 1 for the winner, then by fewest cards left; players with equally many cards share a place. */
export function placementsFor(game: TaiDiGame): number[] {
  return game.hands.map((hand, seat) => {
    if (seat === game.winner) return 1;
    return 1 + game.hands.filter((other) => other.length < hand.length).length;
  });
}
