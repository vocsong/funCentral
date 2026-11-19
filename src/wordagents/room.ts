import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { normalizePlayerName } from '../player-name';
import { newGame, giveClue, guess, endTurn, toggleMark, gameView, shuffle, type Game, type Team } from './engine';

type Role = 'spymaster' | 'operative';
interface Player { id: string; name: string; team: Team | null; role: Role | null; connected: boolean }
interface State {
  roomCode: string;
  /** Board-version guard for clue/guess/end-turn commands. Presence and marks are advisory and do not bump it. */
  revision: number;
  /** The chosen host. It only changes on leave/kick; see effectiveHost for a disconnected host. */
  hostId: string | null;
  players: Player[];
  /** Players the host removed; they can still watch but cannot rejoin this room. */
  removed?: string[];
  game: Game | null;
}
interface Session { id: string; name: string }

export const MAX_PLAYERS = 12;
const EMPTY_ROOM_TTL_MS = 30 * 60_000;
const TEAMS: Team[] = ['red', 'blue'];

/** The stored host while connected, otherwise the first connected player, so a refresh never costs the host the room. */
function effectiveHost(state: State): string | null {
  if (state.players.some(p => p.id === state.hostId && p.connected)) return state.hostId;
  return state.players.find(p => p.connected)?.id ?? state.hostId;
}

/** Split players into two balanced teams, each with one spymaster. */
function randomizeTeams(players: Player[]): void {
  const order = shuffle(players);
  const first: Team = shuffle(TEAMS)[0];
  order.forEach((p, i) => {
    p.team = i % 2 === 0 ? first : first === 'red' ? 'blue' : 'red';
    p.role = i < 2 ? 'spymaster' : 'operative';
  });
}

export class WordAgentsRoom extends DurableObject {
  private sessions = new Map<WebSocket, Session>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session;
      if (s) this.sessions.set(ws, s);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      let state = await this.ctx.storage.get<State>('state');
      if (url.pathname === '/create' && request.method === 'POST') {
        if (state) return new Response('Exists', { status: 409 });
        const { roomCode } = await request.json() as { roomCode: string };
        state = { roomCode, revision: 0, hostId: null, players: [], removed: [], game: null };
        await this.ctx.storage.put('state', state);
        await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
        return Response.json({ ok: true });
      }
      if (!state) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Room not found', { status: 404 });
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.close(4404, 'Room not found');
        return new Response(null, { status: 101, webSocket: client });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
      const id = url.searchParams.get('playerId');
      if (!id) return new Response('Identity required', { status: 401 });
      const [client, server] = Object.values(new WebSocketPair());
      for (const [ws, session] of this.sessions) {
        if (session.id !== id) continue;
        this.sessions.delete(ws);
        try { ws.close(4409, 'Opened in another tab'); } catch { /* already closed */ }
      }
      const session = { id, name: normalizePlayerName(url.searchParams.get('name')) || 'Player' };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(session);
      this.sessions.set(server, session);
      this.syncPresence(state);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put('state', state);
      this.broadcast(state);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session || typeof raw !== 'string' || raw.length > 2048) return;
    if (raw === 'ping') { ws.send('pong'); return; }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    } catch { return; }
    await this.ctx.blockConcurrencyWhile(async () => {
      // A replaced socket must not regain authority while queued.
      if (this.sessions.get(ws) !== session) return;
      const state = await this.ctx.storage.get<State>('state');
      if (!state) return;
      this.syncPresence(state);
      if (msg.type === 'sync') { this.send(ws, state, session.id); return; }
      const player = state.players.find(p => p.id === session.id);
      const host = effectiveHost(state) === session.id;
      const active = !!state.game && state.game.phase !== 'finished';
      // Board commands bump the revision; advisory changes (marks) are broadcast without it.
      let bump = true;
      try {
        switch (msg.type) {
          case 'join':
            if (!/^tg_\d+$/.test(session.id)) throw new Error('Sign in with Telegram to join.');
            if (player) return;
            if (state.removed?.includes(session.id)) throw new Error('The host removed you from this room. You can still watch.');
            // Joining during a round or its results is reserved for the next lobby.
            if (state.game) throw new Error('A round is on the board. You can join when the host returns to the lobby.');
            if (state.players.length >= MAX_PLAYERS) throw new Error(`Room is full (${MAX_PLAYERS} players).`);
            state.players.push({ id: session.id, name: session.name, team: null, role: null, connected: true });
            state.hostId ??= session.id;
            break;
          case 'choose': case 'randomize':
            // An older tab may still send a lobby selection after deployment.
            throw new Error('Teams and roles are assigned when a round starts. Refresh for the new lobby.');
          case 'start':
            if (!host) throw new Error('Only the host can start.');
            if (active) throw new Error('Finish the round first.');
            if (state.players.length < 4) throw new Error('At least four players are needed to start.');
            if (state.players.some(p => !p.connected)) {
              throw new Error('Everyone in the room must be connected. Remove offline players or wait for them.');
            }
            randomizeTeams(state.players);
            state.game = newGame();
            break;
          case 'clue': case 'guess': case 'endTurn': {
            const game = state.game;
            if (!game || msg.gameId !== game.id || msg.revision !== state.revision) throw new Error('The board changed. Please try again.');
            if (!player || player.team !== game.turn) throw new Error('It is not your team’s turn.');
            if (msg.type === 'clue') {
              if (player.role !== 'spymaster') throw new Error('Only the spymaster gives clues.');
              giveClue(game, msg.word, msg.count);
            } else {
              if (player.role !== 'operative') throw new Error('Only operatives can guess or end the turn.');
              if (msg.type === 'guess') guess(game, msg.index);
              else endTurn(game);
            }
            break;
          }
          case 'mark': {
            const game = state.game;
            if (!game || msg.gameId !== game.id) throw new Error('The board changed. Please try again.');
            if (!player || player.team !== game.turn || player.role !== 'operative') throw new Error('Only the guessing team’s operatives can mark cards.');
            toggleMark(game, player.id, msg.index);
            bump = false;
            break;
          }
          case 'abandon':
            // Lets the host recover a round a required player has walked away from.
            if (!host) throw new Error('Only the host can end the round.');
            if (!active) return;
            state.game = null;
            break;
          case 'lobby':
            if (!host) throw new Error('Only the host can return to the lobby.');
            if (active) throw new Error('Finish the round first.');
            if (!state.game) return;
            state.game = null;
            break;
          case 'leave':
            if (!player) return;
            if (active) throw new Error('Roles are locked until the round ends. You can close this tab and reconnect later.');
            state.players = state.players.filter(p => p.id !== session.id);
            if (state.hostId === session.id) state.hostId = state.players.find(p => p.connected)?.id ?? state.players[0]?.id ?? null;
            break;
          case 'kick':
            if (!host || state.game) throw new Error('Only the host can remove players in the lobby.');
            if (msg.playerId === session.id) throw new Error('Use leave instead.');
            if (typeof msg.playerId !== 'string' || !state.players.some(p => p.id === msg.playerId)) return;
            state.players = state.players.filter(p => p.id !== msg.playerId);
            // A stand-in host removing the absent host takes the room over.
            if (state.hostId === msg.playerId) state.hostId = session.id;
            state.removed = [...(state.removed ?? []).filter(id => id !== msg.playerId), msg.playerId].slice(-50);
            break;
          default: return;
        }
        if (bump) state.revision++;
        await this.ctx.storage.put('state', state);
        this.broadcast(state);
      } catch (error) {
        try { ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Action failed.' })); } catch { /* socket closing */ }
        this.send(ws, state, session.id);
      }
    });
  }

  /** Presence comes from live sockets, so a restart without close callbacks can't leave ghosts "connected". */
  private syncPresence(state: State): void {
    const live = new Set([...this.sessions.values()].map(s => s.id));
    for (const p of state.players) p.connected = live.has(p.id);
  }

  private watchers(state: State): number {
    const ids = new Set([...this.sessions.values()].map(s => s.id));
    for (const p of state.players) ids.delete(p.id);
    return ids.size;
  }

  private send(ws: WebSocket, state: State, id: string, watchers = this.watchers(state)) {
    const players = state.game ? state.players : state.players.map(p => ({ ...p, team: null, role: null }));
    const player = players.find(p => p.id === id);
    try {
      ws.send(JSON.stringify({
        type: 'state', roomCode: state.roomCode, revision: state.revision, hostId: effectiveHost(state),
        players, watchers, maxPlayers: MAX_PLAYERS,
        you: { id, team: player?.team ?? null, role: player?.role ?? null, removed: !player && !!state.removed?.includes(id) },
        game: state.game ? gameView(state.game, player?.role === 'spymaster') : null,
      }));
    } catch { /* socket closing */ }
  }

  private broadcast(state: State) {
    const watchers = this.watchers(state);
    for (const [ws, s] of this.sessions) this.send(ws, state, s.id, watchers);
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.disconnect(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.disconnect(ws); }

  private async disconnect(ws: WebSocket) {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<State>('state');
      if (!state) return;
      this.syncPresence(state);
      await this.ctx.storage.put('state', state);
      this.broadcast(state);
      if (!this.sessions.size) await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    });
  }

  async alarm() { if (!this.ctx.getWebSockets().length) await this.ctx.storage.deleteAll(); }
}
