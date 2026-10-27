import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { normalizePlayerName } from '../player-name';
import { newGame, playCards, pass, MIN_PLAYERS, MAX_PLAYERS, type TaiDiGame, type Rng } from './engine';
import { recordTaiDiGame, type RatingChange } from './db';
import { sendMessage, isChatMember, escapeHtml } from '../telegram';

export { MAX_PLAYERS };
const INACTIVITY_MS = 30 * 60 * 1000;
const RATING_RETRY_MS = 60 * 1000;
const VIEW_LOG = 30;

interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  /** Verified Telegram id (the Worker only issues `tg_<id>` player ids after checking the JWT). */
  telegramId: number | null;
  /** Set when the room belongs to a Telegram group: verified members count toward that group's board. */
  isGroupMember?: boolean;
}

interface SeatRating { seat: number; name: string; place: number; before: number; after: number; delta: number }

interface PendingRating {
  gameId: string;
  numPlayers: number;
  /** Finishing place per seat (1 = winner). */
  places: number[];
  seats: RoomPlayer[];
}

interface RoomState {
  roomCode: string;
  players: RoomPlayer[]; // seat order
  hostId: string | null;
  game: TaiDiGame | null;
  gameNo: number;
  gameId: string | null;
  /** Seeded PRNG state, so shuffles are reproducible from a seed (dev/test can pin it at create). */
  rngState: number;
  /** Rating result of the most recent rated game. */
  lastRating: { gameId: string; changes: SeatRating[] } | null;
  ratedGameId: string | null;
  /** Durable outbox: retained across failures, new games, and object eviction. */
  pendingRatings?: PendingRating[];
  idleSince?: number | null;
  /** Telegram group this room was started from (/newtaidi), if any. */
  groupId?: string | null;
  groupName?: string | null;
  origin?: string | null;
}

interface Session {
  playerId: string;
  /** Display name from the verified JWT, if any. */
  name: string | null;
}

/** mulberry32: small, fast, good enough for card shuffles. Advances state.rngState in place. */
function roomRng(state: RoomState): Rng {
  return () => {
    state.rngState = (state.rngState + 0x6d2b79f5) | 0;
    let t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function telegramIdOf(playerId: string): number | null {
  const id = /^tg_(\d+)$/.exec(playerId)?.[1];
  return id ? Number(id) : null;
}

export type TaiDiClientMessage =
  | { type: 'join'; name: string }
  | { type: 'start' }
  | { type: 'play'; cards: string[] }
  | { type: 'pass' }
  | { type: 'backToLobby' }
  | { type: 'kick'; playerId: string }
  | { type: 'leave' };

export class TaiDiRoom extends DurableObject {
  private sessions = new Map<WebSocket, Session>();
  private ratingWork: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Session | null;
      if (attachment) this.sessions.set(ws, attachment);
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      if (await this.getState()) return Response.json({ ok: false }, { status: 409 });
      const { roomCode, seed, groupId, groupName, origin } = (await request.json()) as {
        roomCode: string; seed?: number; groupId?: string | null; groupName?: string | null; origin?: string | null;
      };
      const rngState = Number.isInteger(seed) ? Number(seed) : crypto.getRandomValues(new Uint32Array(1))[0] | 0;
      const state: RoomState = {
        roomCode, players: [], hostId: null, game: null, gameNo: 0, gameId: null, rngState, lastRating: null, ratedGameId: null,
        groupId: groupId ?? null, groupName: groupName ?? null, origin: origin ?? null, idleSince: Date.now(),
      };
      await this.save(state);
      return Response.json({ ok: true });
    }

    // Dev/test only (the Worker gates this route on ALLOW_DEV_LOGIN): patch the live game to set up a scenario.
    if (url.pathname === '/debug/patch' && request.method === 'POST') {
      if ((this.env as Env).ALLOW_DEV_LOGIN !== '1') return new Response('Not found', { status: 404 });
      const state = await this.getState();
      if (!state?.game) return Response.json({ ok: false, error: 'No game in progress' }, { status: 409 });
      Object.assign(state.game, (await request.json()) as Partial<TaiDiGame>);
      await this.save(state);
      this.broadcast(state);
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    const playerId = url.searchParams.get('playerId');
    if (!playerId) return new Response('Missing playerId', { status: 400 });
    const verifiedName = normalizePlayerName(url.searchParams.get('name')) || null;

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const state = await this.getState();
    if (!state) {
      server.send(JSON.stringify({ type: 'error', code: 'notFound', message: 'Room not found' }));
      server.close(4404, 'Room not found');
      return new Response(null, { status: 101, webSocket: client });
    }

    // One live socket per player (e.g. switching from Telegram's browser to the system one).
    for (const [ws, info] of this.sessions) {
      if (info.playerId === playerId) {
        try { ws.close(1000, 'Replaced by new connection'); } catch { /* already closed */ }
        this.sessions.delete(ws);
      }
    }
    const session: Session = { playerId, name: verifiedName };
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    state.idleSince = null;

    const player = state.players.find((p) => p.id === playerId);
    const reconnected = player && !player.connected;
    if (player) player.connected = true;
    await this.save(state);
    if (reconnected) this.broadcast(state);
    else this.sendState(server, state, playerId);
    this.ctx.waitUntil(this.rateFinishedGame());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session || typeof message !== 'string') return;
    let msg: TaiDiClientMessage;
    try { msg = JSON.parse(message); } catch { return; }
    const state = await this.getState();
    if (!state) return;

    const before = { players: state.players.length, gameNo: state.gameNo, ended: state.ratedGameId };
    const error = this.handle(state, session, msg);
    if (error) {
      ws.send(JSON.stringify({ type: 'error', message: error }));
      return;
    }
    if (state.game?.phase === 'done') this.queueRating(state);
    // Storage input gates protect this read/modify/write, but NOT Telegram/D1
    // awaits. Commit the authoritative transition before starting external I/O.
    await this.save(state);
    this.broadcast(state);
    this.ctx.waitUntil(this.rateFinishedGame());
    if (state.groupId) this.ctx.waitUntil(this.notifyGroup(state, before));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code); } catch { /* already closed */ }
    await this.disconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnect(ws);
  }

  async alarm(): Promise<void> {
    await this.rateFinishedGame();
    const state = await this.getState();
    if (!state) return;
    if (state.pendingRatings?.length) {
      await this.ctx.storage.setAlarm(Date.now() + RATING_RETRY_MS);
    } else if (this.sessions.size === 0 && Date.now() >= (state.idleSince ?? 0) + INACTIVITY_MS) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.save(state);
    }
  }

  private async disconnect(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session) return;
    const state = await this.getState();
    if (!state) return;
    if ([...this.sessions.values()].some((s) => s.playerId === session.playerId)) return;
    const player = state.players.find((p) => p.id === session.playerId);
    if (player) player.connected = false;
    if (this.sessions.size === 0) state.idleSince = Date.now();
    await this.save(state);
    this.broadcast(state);
  }

  /** Applies one client message to the room. Returns an error string for the sender, or null. */
  private handle(state: RoomState, session: Session, msg: TaiDiClientMessage): string | null {
    const playerId = session.playerId;
    const seat = state.players.findIndex((p) => p.id === playerId);
    const isHost = state.hostId === playerId;
    const game = state.game;

    switch (msg.type) {
      case 'join': {
        const telegramId = telegramIdOf(playerId);
        if (telegramId === null) return 'Sign in with Telegram to play';
        const name = session.name ?? normalizePlayerName(msg.name);
        if (seat >= 0) {
          if (name) state.players[seat].name = name;
          state.players[seat].connected = true;
          return null;
        }
        if (game) return 'This game has already started — you can watch until it ends';
        if (state.players.length >= MAX_PLAYERS) return `This room is full (${MAX_PLAYERS} players)`;
        state.players.push({ id: playerId, name: name || `Player ${state.players.length + 1}`, connected: true, telegramId });
        state.hostId ??= playerId;
        return null;
      }
      case 'leave': {
        if (seat < 0) return null;
        if (game && game.phase !== 'done') {
          state.players[seat].connected = false;
          return null;
        }
        // Leaving a finished game also returns everyone to the lobby with the new roster.
        state.game = null;
        this.removePlayer(state, seat);
        return null;
      }
      case 'kick': {
        if (!isHost) return 'Only the host can remove players';
        if (game) return 'Players can only be removed in the lobby';
        const target = state.players.findIndex((p) => p.id === msg.playerId);
        if (target < 0 || msg.playerId === playerId) return null;
        this.removePlayer(state, target);
        return null;
      }
      case 'start': {
        if (!isHost) return 'Only the host can start the game';
        if (game) return 'The game has already started';
        if (state.players.length < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players`;
        state.game = newGame(state.players.length, roomRng(state));
        state.gameNo++;
        state.gameId = `${state.roomCode}-${Date.now().toString(36)}-${state.gameNo}`;
        return null;
      }
      case 'backToLobby': {
        if (!game) return null;
        if (game.phase !== 'done' && !isHost) return 'Only the host can end the game early';
        if (seat < 0) return null;
        // A game ended early is not rated: nobody finished, so there is no result.
        state.game = null;
        return null;
      }
    }

    if (!game) return 'The game has not started';
    if (seat < 0) return "You're watching this game";
    switch (msg.type) {
      case 'play': return playCards(game, seat, asCards(msg.cards));
      case 'pass': return pass(game, seat);
    }
    return 'Unknown action';
  }

  private queueRating(state: RoomState): void {
    const game = state.game;
    if (!game?.placements || !state.gameId || state.ratedGameId === state.gameId) return;
    const pending = state.pendingRatings ??= [];
    if (pending.some((p) => p.gameId === state.gameId)) return;
    pending.push({
      gameId: state.gameId, numPlayers: game.numPlayers, places: [...game.placements], seats: state.players.map((p) => ({ ...p })),
    });
  }

  /** Writes ratings once per finished game. */
  private async rateFinishedGame(): Promise<void> {
    // Only coalesce external work; gameplay never waits on this promise.
    if (this.ratingWork) return this.ratingWork;
    this.ratingWork = this.drainRatings();
    try { await this.ratingWork; } finally { this.ratingWork = null; }
  }

  private async drainRatings(): Promise<void> {
    const env = this.env as Env;
    try {
      for (;;) {
        const state = await this.getState();
        const pending = state?.pendingRatings?.[0];
        if (!state || !pending) return;
        // A quick game can finish before the join's membership lookup returns.
        if (state.groupId) {
          for (const p of pending.seats) {
            if (p.telegramId !== null && p.isGroupMember === undefined) {
              p.isGroupMember = await isChatMember(env.TELEGRAM_BOT_TOKEN, state.groupId, p.telegramId);
            }
          }
        }
        const players = pending.seats.flatMap((p, seat) => (p.telegramId === null ? [] : [{ telegramId: p.telegramId, place: pending.places[seat] }]));
        let changes = await recordTaiDiGame(env.DB, {
          gameId: pending.gameId, roomCode: state.roomCode, numPlayers: pending.numPlayers, players,
          groupId: state.groupId,
          memberIds: pending.seats.filter((p) => p.isGroupMember && p.telegramId !== null).map((p) => p.telegramId!),
        });
        if (!changes.length) {
          // The batch may have committed before an eviction/failed local save.
          const history = await env.DB.prepare(
            `SELECT telegram_id AS telegramId, rating_before AS before, rating_after AS after, delta
             FROM taidi_rating_history WHERE game_id = ?`,
          ).bind(pending.gameId).all<RatingChange>();
          changes = history.results ?? [];
        }
        // Never save the pre-I/O snapshot: joins, starts, and disconnects may
        // have committed while D1 or Telegram was outstanding.
        const current = await this.getState();
        if (!current?.pendingRatings?.some((p) => p.gameId === pending.gameId)) continue;
        const before = { players: current.players.length, gameNo: current.gameNo, ended: current.ratedGameId };
        current.pendingRatings = current.pendingRatings.filter((p) => p.gameId !== pending.gameId);
        current.ratedGameId = pending.gameId;
        current.lastRating = {
          gameId: pending.gameId,
          changes: changes.map((c) => {
            const seat = pending.seats.findIndex((p) => p.telegramId === c.telegramId);
            return { seat, name: pending.seats[seat]?.name ?? '', place: pending.places[seat] ?? 0, before: c.before, after: c.after, delta: c.delta };
          }),
        };
        await this.save(current);
        this.broadcast(current);
        if (current.groupId) this.ctx.waitUntil(this.notifyGroup(current, before));
      }
    } catch (err) {
      // The durable outbox and its alarm remain intact until all writes succeed.
      console.error('Tai Di rating failed; will retry', err);
    }
  }

  /** Group-chat updates for rooms started from Telegram, like Bridge's (lobby joins, start, result). */
  private async notifyGroup(state: RoomState, before: { players: number; gameNo: number; ended: string | null }): Promise<void> {
    const env = this.env as Env;
    const groupId = state.groupId!;
    const post = (text: string) => this.ctx.waitUntil(sendMessage(env.TELEGRAM_BOT_TOKEN, groupId, text));
    const names = (list: RoomPlayer[]) => list.map((p) => escapeHtml(p.name)).join(', ');
    const link = state.origin ? `${state.origin}/taidi/#${state.roomCode}` : null;

    // New seat: verify membership first, so the group board only counts the group.
    if (state.players.length > before.players) {
      const joined = state.players[state.players.length - 1];
      const isGroupMember = joined.telegramId !== null && await isChatMember(env.TELEGRAM_BOT_TOKEN, groupId, joined.telegramId);
      const current = await this.getState();
      const player = current?.players.find((p) => p.id === joined.id);
      if (current && player) {
        player.isGroupMember = isGroupMember;
        await this.save(current);
        this.broadcast(current);
      }
      const n = state.players.length;
      post(`👤 <b>${escapeHtml(joined.name)}</b> joined the Tai Di lobby (${n}/${MAX_PLAYERS})\nPlayers: ${names(state.players)}${link && n < MAX_PLAYERS ? `\n🎴 Join → ${link}` : ''}`);
    }
    if (state.gameNo > before.gameNo && state.game) {
      post(`🎴 Tai Di started — ${state.game.numPlayers} players: ${names(state.players)}`);
    }
    // A game was just rated.
    const rating = state.lastRating;
    if (rating && state.ratedGameId !== before.ended && rating.gameId === state.ratedGameId) {
      const ordered = [...rating.changes].sort((a, b) => a.place - b.place);
      const winner = ordered.find((c) => c.place === 1);
      const lines = ordered.map((c) => `  ${c.place}. ${escapeHtml(c.name)}: ${c.delta >= 0 ? '+' : ''}${c.delta} → ${c.after}`).join('\n');
      post(`🏆 <b>${winner ? escapeHtml(winner.name) : 'Someone'}</b> went out first in Tai Di!${lines ? `\n${lines}` : ''}`);
    }
  }

  private removePlayer(state: RoomState, seat: number): void {
    const [removed] = state.players.splice(seat, 1);
    if (state.hostId === removed.id) state.hostId = state.players[0]?.id ?? null;
  }

  private async getState(): Promise<RoomState | null> {
    const state = (await this.ctx.storage.get<RoomState>('state')) ?? null;
    if (state) state.rngState ??= crypto.getRandomValues(new Uint32Array(1))[0] | 0;
    return state;
  }

  private async save(state: RoomState): Promise<void> {
    // Issue together: the outbox and wakeup are committed under storage gates.
    const write = this.ctx.storage.put('state', state);
    const alarm = state.pendingRatings?.length
      ? this.ctx.storage.setAlarm(Date.now() + RATING_RETRY_MS)
      : this.sessions.size === 0
        ? this.ctx.storage.setAlarm((state.idleSince ?? Date.now()) + INACTIVITY_MS)
        : this.ctx.storage.deleteAlarm();
    await Promise.all([write, alarm]);
  }

  private broadcast(state: RoomState): void {
    for (const [ws, session] of this.sessions) this.sendState(ws, state, session.playerId);
  }

  private sendState(ws: WebSocket, state: RoomState, playerId: string): void {
    try { ws.send(JSON.stringify(buildView(state, playerId))); } catch { /* closing */ }
  }
}

function asCards(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string').slice(0, 5) : [];
}

/** The per-recipient view: your own hand, everyone's card counts, and the public table. Spectators get no hand. */
export function buildView(state: RoomState, playerId: string) {
  const seat = state.players.findIndex((p) => p.id === playerId);
  const game = state.game;
  return {
    type: 'state' as const,
    roomCode: state.roomCode,
    gameNo: state.gameNo,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    you: { seat, isHost: state.hostId === playerId, id: playerId },
    players: state.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected, isHost: p.id === state.hostId,
      // Only meaningful in group rooms: false = plays and is rated, but doesn't count for the group board.
      isGroupMember: state.groupId ? p.isGroupMember ?? null : null,
    })),
    groupName: state.groupName ?? null,
    gameId: state.gameId,
    lastRating: state.lastRating,
    game: game && {
      numPlayers: game.numPlayers,
      phase: game.phase,
      currentSeat: game.currentSeat,
      hand: seat >= 0 ? game.hands[seat] : null,
      handCounts: game.hands.map((h) => h.length),
      /** The face-up card in a 3-player deal (public), and how many cards sit out of a 2-player deal. */
      exposed: game.exposed,
      unused: game.unused,
      table: game.table,
      passes: game.passes,
      mustInclude: game.mustInclude,
      canPass: game.phase === 'play' && game.table !== null,
      winner: game.winner,
      placements: game.placements,
      log: game.log.slice(-VIEW_LOG),
    },
  };
}
