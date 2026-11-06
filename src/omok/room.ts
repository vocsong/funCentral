import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { normalizePlayerName } from '../player-name';
import { newGame, placeStone, resignGame, stoneOf, MIN_PLAYERS, MAX_PLAYERS, type OmokGame } from './engine';
import { findBotMove } from './bot';
import { recordOmokGame, type RatingChange } from './db';
import { sendMessage, isChatMember, escapeHtml } from '../telegram';

export { MAX_PLAYERS };
const INACTIVITY_MS = 30 * 60 * 1000;
const RATING_RETRY_MS = 60 * 1000;
const BOT_DELAY_MS = 700;
const OPENING_REVEAL_MS = 2200;
const VIEW_LOG = 20;

interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  /** Verified Telegram id (the Worker only issues `tg_<id>` player ids after checking the JWT). */
  telegramId: number | null;
  /** Set when the room belongs to a Telegram group: verified members count toward that group's board. */
  isGroupMember?: boolean;
  /** True for the practice opponent; bot games are not rated. */
  isBot?: boolean;
}

interface SeatRating {
  seat: number;
  name: string;
  place: number;
  won: boolean;
  draw: boolean;
  before: number;
  after: number;
  delta: number;
}

interface PendingRating {
  gameId: string;
  numPlayers: number;
  /** Outcome per seat (1 = win, 2 = loss; both 1 on a draw). */
  places: number[];
  won: boolean[];
  draw: boolean[];
  seats: RoomPlayer[];
}

interface RoomState {
  roomCode: string;
  players: RoomPlayer[]; // seat order
  hostId: string | null;
  game: OmokGame | null;
  gameNo: number;
  /** Picked randomly for the first game, then alternated and persisted per room. */
  nextStartingSeat?: number;
  /** No stone may be placed until the shared opening-border reveal finishes. */
  openingUntil?: number | null;
  gameId: string | null;
  /** Rating result of the most recent rated game. */
  lastRating: { gameId: string; changes: SeatRating[] } | null;
  ratedGameId: string | null;
  /** Durable outbox: retained across failures, new games, and object eviction. */
  pendingRatings?: PendingRating[];
  idleSince?: number | null;
  /** Telegram group this room was started from (/newomok), if any. */
  groupId?: string | null;
  groupName?: string | null;
  origin?: string | null;
  /** Player ids removed by the host in the lobby. A reconnect must not undo a kick. */
  kickedIds?: string[];
  /** When a scheduled bot move should fire (alarm-based so it survives eviction). */
  botMoveAt?: number | null;
}

interface Session {
  playerId: string;
  /** Display name from the verified JWT, if any. */
  name: string | null;
}

function telegramIdOf(playerId: string): number | null {
  const id = /^tg_(\d+)$/.exec(playerId)?.[1];
  return id ? Number(id) : null;
}

export type OmokClientMessage =
  | { type: 'join'; name: string }
  | { type: 'start' }
  | { type: 'place'; row: number; col: number; gameId: string; moveNumber: number }
  | { type: 'resign'; gameId: string }
  | { type: 'backToLobby' }
  | { type: 'kick'; playerId: string }
  | { type: 'addBot' }
  | { type: 'leave' };

export class OmokRoom extends DurableObject {
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
      const { roomCode, groupId, groupName, origin } = (await request.json()) as {
        roomCode: string; groupId?: string | null; groupName?: string | null; origin?: string | null;
      };
      const state: RoomState = {
        roomCode, players: [], hostId: null, game: null, gameNo: 0, gameId: null,
        lastRating: null, ratedGameId: null,
        groupId: groupId ?? null, groupName: groupName ?? null, origin: origin ?? null,
        idleSince: Date.now(), kickedIds: [],
        nextStartingSeat: crypto.getRandomValues(new Uint8Array(1))[0] & 1,
      };
      await this.save(state);
      return Response.json({ ok: true });
    }

    // Dev/test only (the Worker gates this route on ALLOW_DEV_LOGIN): patch the live game to set up a scenario.
    if (url.pathname === '/debug/patch' && request.method === 'POST') {
      if ((this.env as Env).ALLOW_DEV_LOGIN !== '1') return new Response('Not found', { status: 404 });
      const state = await this.getState();
      if (!state?.game) return Response.json({ ok: false, error: 'No game in progress' }, { status: 409 });
      Object.assign(state.game, (await request.json()) as Partial<OmokGame>);
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
    let msg: OmokClientMessage;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    const state = await this.getState();
    if (!state) return;

    const before = { players: state.players.length, gameNo: state.gameNo, ended: state.ratedGameId };
    const error = this.handle(state, session, msg);
    if (error) {
      ws.send(JSON.stringify({ type: 'error', message: error }));
      return;
    }
    if (state.game?.phase === 'done') this.queueRating(state);
    this.syncBotMove(state);
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
    // Rating I/O may still belong to an earlier round. Keep it in the durable
    // outbox and retry in the background so it cannot hold up a due bot move.
    this.ctx.waitUntil(this.rateFinishedGame());
    const state = await this.getState();
    if (!state) return;
    const now = Date.now();
    // A cold runtime may have no sockets without a preceding close callback.
    // Begin a fresh idle window instead of treating a null timestamp as 1970.
    if (this.sessions.size === 0) state.idleSince ??= now;
    // A scheduled bot move fires on the alarm so it survives object eviction.
    if (state.botMoveAt && now >= state.botMoveAt) {
      state.botMoveAt = null;
      this.applyBotMove(state);
      this.syncBotMove(state);
      await this.save(state);
      this.broadcast(state);
      return;
    }
    if (state.pendingRatings?.length) {
      await this.ctx.storage.setAlarm(now + RATING_RETRY_MS);
    } else if (this.sessions.size === 0 && now >= (state.idleSince ?? 0) + INACTIVITY_MS) {
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
  private handle(state: RoomState, session: Session, msg: OmokClientMessage): string | null {
    const playerId = session.playerId;
    const seat = state.players.findIndex((p) => p.id === playerId);
    const isHost = state.hostId === playerId;
    const game = state.game;

    switch (msg.type) {
      case 'join': {
        const telegramId = telegramIdOf(playerId);
        if (telegramId === null) return 'Sign in with Telegram to play';
        if ((state.kickedIds ?? []).includes(playerId)) return 'You were removed from this lobby';
        const name = session.name ?? normalizePlayerName(msg.name);
        if (seat >= 0) {
          if (name) state.players[seat].name = name;
          state.players[seat].connected = true;
          return null;
        }
        if (game) return 'This game has already started — you can watch until it ends';
        if (state.players.length >= MAX_PLAYERS) return `This room is full (${MAX_PLAYERS} players)`; // prettier-ignore
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
        const removedId = state.players[target].id;
        this.removePlayer(state, target);
        const kicked = state.kickedIds ??= [];
        if (!kicked.includes(removedId)) kicked.push(removedId);
        return null;
      }
      case 'addBot': {
        if (!isHost) return 'Only the host can add a bot';
        if (game) return 'A bot can only be added in the lobby';
        if (state.players.length >= MAX_PLAYERS) return `This room is full (${MAX_PLAYERS} players)`;
        if (state.players.some((p) => p.isBot)) return 'A bot is already seated';
        state.players.push({ id: `bot_${crypto.randomUUID()}`, name: 'Bot', connected: true, telegramId: null, isBot: true });
        state.hostId ??= playerId;
        return null;
      }
      case 'start': {
        if (!isHost) return 'Only the host can start the game';
        if (game) return 'The game has already started';
        if (state.players.length < MIN_PLAYERS) return `Need ${MIN_PLAYERS} players to play Omok`;
        const startingSeat = state.nextStartingSeat ?? (crypto.getRandomValues(new Uint8Array(1))[0] & 1);
        state.game = newGame(startingSeat);
        state.openingUntil = Date.now() + OPENING_REVEAL_MS;
        state.nextStartingSeat = 1 - startingSeat;
        state.gameNo++;
        state.gameId = `${state.roomCode}-${Date.now().toString(36)}-${state.gameNo}`;
        return null;
      }
      case 'backToLobby': {
        if (!game) return null;
        if (seat < 0) return "You're watching this game";
        if (game.phase !== 'done') return 'Finish the round before returning to the lobby';
        state.game = null;
        return null;
      }
    }

    if (!game) return 'The game has not started';
    if (seat < 0) return "You're watching this game";
    switch (msg.type) {
      case 'place': {
        if (msg.gameId !== state.gameId || msg.moveNumber !== game.moveCount) return 'The board changed. Choose your move again';
        if (Date.now() < (state.openingUntil ?? 0)) return 'Wait for the starting-player reveal';
        return placeStone(game, seat, asCoordinate(msg.row), asCoordinate(msg.col));
      }
      case 'resign': {
        if (msg.gameId !== state.gameId) return 'The game changed';
        return resignGame(game, seat);
      }
    }
    return 'Unknown action';
  }

  private queueRating(state: RoomState): void {
    const game = state.game;
    if (!game || game.phase !== 'done' || !state.gameId || state.ratedGameId === state.gameId) return;
    // Practice games against a bot are not rated.
    if (state.players.some((p) => p.isBot)) return;
    const pending = state.pendingRatings ??= [];
    if (pending.some((p) => p.gameId === state.gameId)) return;
    pending.push({
      gameId: state.gameId,
      numPlayers: 2,
      places: game.isDraw ? [1, 1] : game.winner === 0 ? [1, 2] : [2, 1],
      won: game.isDraw ? [false, false] : game.winner === 0 ? [true, false] : [false, true],
      draw: [game.isDraw, game.isDraw],
      seats: state.players.map((p) => ({ ...p })),
    });
  }

  /** Writes ratings once per finished game. */
  private async rateFinishedGame(): Promise<void> {
    if (this.ratingWork) return this.ratingWork;
    this.ratingWork = this.drainRatings();
    try { await this.ratingWork; } finally { this.ratingWork = null; }
  }

  /** Schedules a bot move (or clears the schedule) to match the current turn. */
  private syncBotMove(state: RoomState): void {
    const game = state.game;
    if (game?.phase === 'play' && state.players[game.currentSeat]?.isBot) {
      state.botMoveAt ??= Math.max(Date.now(), state.openingUntil ?? 0) + BOT_DELAY_MS;
    } else {
      state.botMoveAt = null;
    }
  }

  /** Plays the bot's turn when the alarm fires and it is the bot's move. */
  private applyBotMove(state: RoomState): void {
    const game = state.game;
    if (!game || game.phase !== 'play') return;
    const seat = game.currentSeat;
    if (!state.players[seat]?.isBot) return;
    const move = findBotMove(game, seat);
    if (move === null) return;
    placeStone(game, seat, move.row, move.col);
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
        const players = pending.seats.flatMap((p, seat) => (p.telegramId === null ? [] : [{
          telegramId: p.telegramId, place: pending.places[seat], won: pending.won[seat], draw: pending.draw[seat],
        }]));
        let changes = await recordOmokGame(env.DB, {
          gameId: pending.gameId, roomCode: state.roomCode, numPlayers: pending.numPlayers, players,
          groupId: state.groupId,
          memberIds: pending.seats.filter((p) => p.isGroupMember && p.telegramId !== null).map((p) => p.telegramId!),
        });
        if (!changes.length) {
          const history = await env.DB.prepare(
            `SELECT telegram_id AS telegramId, rating_before AS before, rating_after AS after, delta
             FROM omok_rating_history WHERE game_id = ?`,
          ).bind(pending.gameId).all<RatingChange>();
          changes = history.results ?? [];
        }
        const current = await this.getState();
        if (!current?.pendingRatings?.some((p) => p.gameId === pending.gameId)) continue;
        const before = { players: current.players.length, gameNo: current.gameNo, ended: current.ratedGameId };
        current.pendingRatings = current.pendingRatings.filter((p) => p.gameId !== pending.gameId);
        current.ratedGameId = pending.gameId;
        current.lastRating = {
          gameId: pending.gameId,
          changes: changes.map((c) => {
            const seat = pending.seats.findIndex((p) => p.telegramId === c.telegramId);
            return {
              seat, name: pending.seats[seat]?.name ?? '', place: pending.places[seat] ?? 0,
              won: pending.won[seat] ?? false, draw: pending.draw[seat] ?? false,
              before: c.before, after: c.after, delta: c.delta,
            };
          }),
        };
        await this.save(current);
        this.broadcast(current);
        if (current.groupId) this.ctx.waitUntil(this.notifyGroup(current, before));
      }
    } catch (err) {
      console.error('Omok rating failed; will retry', err);
    }
  }

  /** Group-chat updates for rooms started from Telegram, like Bridge's (lobby joins, start, result). */
  private async notifyGroup(state: RoomState, before: { players: number; gameNo: number; ended: string | null }): Promise<void> {
    const env = this.env as Env;
    const groupId = state.groupId!;
    const post = (text: string) => this.ctx.waitUntil(sendMessage(env.TELEGRAM_BOT_TOKEN, groupId, text));
    const names = (list: RoomPlayer[]) => list.map((p) => escapeHtml(p.name)).join(' vs ');
    const link = state.origin ? `${state.origin}/omok/#${state.roomCode}` : null;

    if (state.players.length > before.players) {
      const joined = state.players[state.players.length - 1];
      if (joined.isBot) {
        post(`🤖 <b>Bot</b> joined the Omok lobby (${state.players.length}/${MAX_PLAYERS})${link && state.players.length < MAX_PLAYERS ? `\n🔴 Join → ${link}` : ''}`);
      } else {
        const isGroupMember = joined.telegramId !== null && await isChatMember(env.TELEGRAM_BOT_TOKEN, groupId, joined.telegramId);
        const current = await this.getState();
        const player = current?.players.find((p) => p.id === joined.id);
        if (current && player) {
          player.isGroupMember = isGroupMember;
          await this.save(current);
          this.broadcast(current);
        }
        post(`👤 <b>${escapeHtml(joined.name)}</b> joined the Omok lobby (${state.players.length}/${MAX_PLAYERS})${link && state.players.length < MAX_PLAYERS ? `\n🔴 Join → ${link}` : ''}`);
      }
    }
    if (state.gameNo > before.gameNo && state.game) {
      post(`🔴 Omok started — ${names(state.players)}`);
    }
    const rating = state.lastRating;
    if (rating && state.ratedGameId !== before.ended && rating.gameId === state.ratedGameId) {
      const winner = rating.changes.find((c) => c.won);
      const lines = rating.changes.map((c) => `  ${escapeHtml(c.name)}: ${c.delta >= 0 ? '+' : ''}${c.delta} → ${c.after}`).join('\n');
      if (winner) post(`🏆 <b>${escapeHtml(winner.name)}</b> won Omok!${lines ? `\n${lines}` : ''}`);
      else post(`🤝 Omok ended in a draw.${lines ? `\n${lines}` : ''}`);
    }
  }

  private removePlayer(state: RoomState, seat: number): void {
    state.players.splice(seat, 1);
    this.ensureHumanHost(state);
  }

  /** Repair old bot-hosted rooms too; pending rating work must survive cleanup. */
  private ensureHumanHost(state: RoomState): void {
    const humans = state.players.filter((p) => !p.isBot);
    if (!humans.length) {
      state.players = [];
      state.hostId = null;
      state.game = null;
      state.botMoveAt = null;
      state.openingUntil = null;
    } else if (!humans.some((p) => p.id === state.hostId)) {
      state.hostId = humans[0].id;
    }
  }

  private async getState(): Promise<RoomState | null> {
    const state = (await this.ctx.storage.get<RoomState>('state')) ?? null;
    if (state) {
      state.kickedIds ??= [];
      state.botMoveAt ??= null;
      this.ensureHumanHost(state);
    }
    return state;
  }

  private async save(state: RoomState): Promise<void> {
    const write = this.ctx.storage.put('state', state);
    let alarmAt: number | null = null;
    if (state.botMoveAt) alarmAt = state.botMoveAt;
    else if (state.pendingRatings?.length) alarmAt = Date.now() + RATING_RETRY_MS;
    else if (this.sessions.size === 0) alarmAt = (state.idleSince ?? Date.now()) + INACTIVITY_MS;
    const alarm = alarmAt ? this.ctx.storage.setAlarm(alarmAt) : this.ctx.storage.deleteAlarm();
    await Promise.all([write, alarm]);
  }

  private broadcast(state: RoomState): void {
    for (const [ws, session] of this.sessions) this.sendState(ws, state, session.playerId);
  }

  private sendState(ws: WebSocket, state: RoomState, playerId: string): void {
    try { ws.send(JSON.stringify(buildView(state, playerId))); } catch { /* closing */ }
  }
}

function asCoordinate(value: unknown): number {
  return typeof value === 'number' ? value : NaN;
}

/** The per-recipient view: the whole board is public, so spectators see the same state. */
export function buildView(state: RoomState, playerId: string) {
  const seat = state.players.findIndex((p) => p.id === playerId);
  const game = state.game;
  return {
    type: 'state' as const,
    roomCode: state.roomCode,
    serverTime: Date.now(),
    gameNo: state.gameNo,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    you: { seat, isHost: state.hostId === playerId, id: playerId, kicked: (state.kickedIds ?? []).includes(playerId) },
    players: state.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected, isHost: p.id === state.hostId, isBot: p.isBot === true,
      isGroupMember: state.groupId ? p.isGroupMember ?? null : null,
    })),
    groupName: state.groupName ?? null,
    nextStartingSeat: state.nextStartingSeat ?? 0,
    gameId: state.gameId,
    lastRating: state.lastRating,
    game: game && {
      numPlayers: 2,
      opensAt: state.openingUntil ?? 0,
      phase: game.phase,
      currentSeat: game.currentSeat,
      board: game.board,
      blackSeat: game.blackSeat,
      yourStone: seat >= 0 ? stoneOf(game, seat) : null,
      endReason: game.endReason,
      winner: game.winner,
      isDraw: game.isDraw,
      winningLine: game.winningLine,
      lastMove: game.lastMove,
      moveCount: game.moveCount,
      log: game.log.slice(-VIEW_LOG),
    },
  };
}
