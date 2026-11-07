import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';

export type Suit = '♣' | '♦' | '♥' | '♠';
export type BidSuit = Suit | '🚫';

export const CARD_SUITS: Suit[] = ['♣', '♦', '♥', '♠'];
export const BID_SUITS: BidSuit[] = ['♣', '♦', '♥', '♠', '🚫'];

export type Hand = Record<Suit, string[]>;

export type GamePhase = 'lobby' | 'bidding' | 'partner' | 'play' | 'gameover';

export interface Player {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
  wins?: number;
  gamesPlayed?: number;
  isBot?: boolean;
  isGodBot?: boolean;
  botLevel?: 'basic' | 'intermediate' | 'advanced' | 'sophisticated';
  isGroupMember?: boolean;
  elo?: number;
  originalPlayerId?: string; // If this bot is replacing a human, store the original player's ID
}

export interface TrickRecord {
  cards: (string | null)[];
  winner: number;
}

export interface Spectator {
  id: string;
  name: string;
  watchingSeat: number; // -1 = not yet chosen, -2 = full board view, 0-3 = specific seat
}

export interface BidHistoryEntry {
  seat: number;
  name: string;
  bidNum: number | null; // null = pass
}

export interface TrickLogEntry {
  trickNum: number;   // 1-based
  playOrder: number;  // 1 = lead, 4 = last
  seat: number;
  card: string;       // e.g. "A ♠"
}

export interface GameState {
  roomCode: string;
  phase: GamePhase;
  players: Player[];
  hands: Hand[];
  turn: number;
  bidder: number;
  bid: number;
  trumpSuit: BidSuit | null;
  setsNeeded: number;
  sets: number[];
  trumpBroken: boolean;
  firstPlayer: number;
  currentSuit: Suit | null;
  playedCards: (string | null)[];
  partner: number;
  partnerCard: string | null;
  passCount: number;
  lastTrick: TrickRecord | null;
  trickComplete: boolean;
  bidHistory: BidHistoryEntry[];
  spectators: Spectator[];
  firstBidder: number;
  groupId: string | null;
  groupName: string | null;
  gameStartAt: number | null;
  partnerRevealed: boolean;
  gameId: string;
  readySeats: number[];
  trickLog: TrickLogEntry[];
  trickWinners: number[];
  initialHands: Hand[];
  origin: string | null;
  pingCooldowns: { [seat: number]: number }; // timestamp of last ping per recipient seat
  disconnectTimers: { [seat: number]: number }; // timestamp when player disconnected (0 if connected)
  isPractice: boolean; // snapshotted at deal start; not recomputed mid-game when bots replace humans
  redealCount?: number; // all-pass redeals before this hand's bidding succeeded
  replacedSeats?: number[]; // seats a bot took over during this hand, even if the human later returned
  dealtBotSeats?: number[]; // seats held by a bot when this hand was dealt; they credit no human
  seasonId?: number; // Bridge season the hand was dealt in (src/seasons.ts); absent = Season 1
  abandonVote?: {
    initiatorSeat: number;
    initiatorId: string;
    votes: { [seat: number]: boolean | null }; // true=yes, false=no, null=no response yet
    expiresAt: number; // timestamp when vote expires (1 minute timeout)
  };
}

export interface PlayerGameView {
  roomCode: string;
  phase: GamePhase;
  players: { name: string; seat: number; connected: boolean; wins?: number; gamesPlayed?: number; isBot?: boolean; isGodBot?: boolean; botLevel?: 'basic' | 'intermediate' | 'advanced' | 'sophisticated'; isGroupMember?: boolean; elo?: number; telegramId?: number; disconnectedAt?: number }[];
  hand: Hand | null;
  allHands: Hand[] | null; // all 4 hands, only for full-board spectators (watchingSeat === -2)
  turn: number;
  bidder: number;
  bid: number;
  trumpSuit: BidSuit | null;
  setsNeeded: number;
  sets: number[];
  trumpBroken: boolean;
  firstPlayer: number;
  currentSuit: Suit | null;
  playedCards: (string | null)[];
  partnerCard: string | null;
  isPartner: boolean;
  mySeat: number;
  lastTrick: TrickRecord | null;
  trickComplete: boolean;
  bidHistory: BidHistoryEntry[];
  isSpectator: boolean;
  watchingSeat: number;
  groupId: string | null;
  groupName: string | null;
  gameStartAt: number | null;
  isGroupMember?: boolean;
  partnerSeat: number;
  spectators: { name: string; watchingSeat: number }[];
  readySeats: number[];
  allInitialHands: Hand[] | null;
  allFinalHands: Hand[] | null;
  /** Full trick history for recap UI (game over only). */
  trickLog: TrickLogEntry[] | null;
  trickWinners: number[] | null;
  gameId: string;
  isPractice: boolean;
}

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  REGICIDE_ROOM: DurableObjectNamespace;
  TAIDI_ROOM: DurableObjectNamespace;
  CONNECT4_ROOM: DurableObjectNamespace;
  OMOK_ROOM: DurableObjectNamespace;
  DB: D1Database;
  JWT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_USERNAME: string;
  TELEGRAM_WEBHOOK_SECRET?: string; // must match Telegram setWebhook secret_token; webhook fails closed without it
  ALLOW_DEV_LOGIN?: string;
  TEST_NOW_MS?: string; // local tests only: pins the Bridge season clock (ignored without ALLOW_DEV_LOGIN)
}

export const NUM_PLAYERS = 4;
export const MAX_BID = 34;
export const POINTS_TO_WASH = 4;
