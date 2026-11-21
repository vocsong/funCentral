import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { newGame } from '../src/flip7/engine';

let mf: Miniflare;
type Namespace = Awaited<ReturnType<Miniflare['getDurableObjectNamespace']>>;
let room: ReturnType<Namespace['get']>;
beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: { contents: `import {Flip7Room as ProductionRoom} from './src/flip7/room';
      export class Flip7Room extends ProductionRoom {
        async fetch(request) {
          if (new URL(request.url).pathname === '/__state') {
            if (request.method === 'POST') await this.ctx.storage.put('state', await request.json());
            return Response.json(await this.ctx.storage.get('state'));
          }
          return super.fetch(request);
        }
      }
      export default {fetch(){return new Response('test')}}`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:*'],
  });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'Flip7Room', useSQLite: true } },
  }));
  await mf.ready;
  const ns = await mf.getDurableObjectNamespace('ROOM');
  room = ns.get(ns.idFromName('F7OK'));
  const create = await room.fetch('https://test/create', { method: 'POST', body: JSON.stringify({ roomCode: 'F7OK' }) });
  expect(create.ok).toBe(true);
}, 30_000);
afterAll(async () => { await mf?.dispose(); });

async function connect(id: string) {
  const { webSocket: ws } = await room.fetch(`https://test/ws?playerId=${id}&name=Seat${id}`, { headers: { Upgrade: 'websocket' } });
  if (!ws) throw new Error('Missing room websocket');
  const frames: any[] = [];
  ws.addEventListener('message', e => frames.push(JSON.parse(String(e.data))));
  ws.accept();
  return {
    id, ws,
    send: (message: object) => ws.send(JSON.stringify(message)),
    state: () => frames.filter(f => f.type === 'state').at(-1),
    error: (pattern: RegExp) => frames.filter(f => f.type === 'error').some(f => pattern.test(f.message)),
  };
}

it('authorizes seats and host, rejects stale actions, and replays authoritative state on reconnect', async () => {
  const sockets: Awaited<ReturnType<typeof connect>>[] = [];
  const open = async (id: string) => { const c = await connect(id); sockets.push(c); return c; };
  try {
    const guest = await open('guest_watch');
    guest.send({ type: 'join' });
    await expect.poll(() => guest.error(/sign in/i)).toBe(true);
    const seats = [];
    for (let i = 1; i <= 3; i++) {
      const c = await open(`tg_${i}`);
      seats.push(c);
      c.send({ type: 'join' });
      await expect.poll(() => c.state()?.players.length).toBe(i);
      if (i === 1) {
        c.send({ type: 'start' });
        await expect.poll(() => c.error(/three/i)).toBe(true);
      }
    }
    const host = seats[0];
    seats[1].send({ type: 'start' });
    await expect.poll(() => seats[1].error(/only the host/i)).toBe(true);
    host.send({ type: 'start' });
    await expect.poll(() => guest.state()?.game?.id).toBeTypeOf('string');
    const started = guest.state();
    expect(started.hostId).toBe(host.id);
    expect(started.watchers).toBe(1);
    expect(started.game).not.toHaveProperty('deck');
    expect(started.game.players.every((p: { held?: unknown }) => !p.held)).toBe(true);
    const late = await open('tg_9');
    late.send({ type: 'join' });
    await expect.poll(() => late.error(/lobby/i)).toBe(true);
    const game = started.game;
    const next = game.pending ? { type: 'target', playerId: game.pending.targets[0] }
      : game.phase === 'roundEnd' ? { type: 'nextRound' } : { type: 'hit' };
    const actorId = game.pending?.actorId ?? game.turnId ?? host.id;
    const actor = seats.find(c => c.id === actorId)!;
    const move = { ...next, gameId: game.id, revision: started.revision };
    guest.send(move);
    await expect.poll(() => guest.error(/seated/i)).toBe(true);
    actor.send(move);
    actor.send(move);
    await expect.poll(() => actor.error(/changed/i)).toBe(true);
    await expect.poll(() => guest.state()?.revision).toBe(started.revision + 1);
    const committed = guest.state();
    const reconnect = await open(actor.id);
    reconnect.send({ type: 'sync' });
    await expect.poll(() => reconnect.state()?.game).toEqual(committed.game);
    expect(reconnect.state().revision).toBe(committed.revision);
    expect(reconnect.state().you.id).toBe(actor.id);
    host.send({ type: 'abandon', gameId: game.id, revision: committed.revision });
    if (actor.id === host.id) reconnect.send({ type: 'abandon', gameId: game.id, revision: committed.revision });
    await expect.poll(() => guest.state()?.game).toBeNull();
  } finally {
    for (const c of sockets) { try { c.ws.close(); } catch { /* closed or replaced */ } }
  }
}, 30_000);


it('broadcasts action sequences and exact forced bust evidence, persists them, and restores them on reconnect', async () => {
  const ids = ['tg_11', 'tg_12', 'tg_13'];
  const game = newGame(ids, [
    { type: 'number', value: 1 }, { type: 'number', value: 2 }, { type: 'number', value: 3 },
    { type: 'flipThree' }, { type: 'secondChance' }, { type: 'number', value: 2 },
    { type: 'number', value: 2 }, { type: 'number', value: 12 },
  ], 2);
  await room.fetch('https://test/__state', { method: 'POST', body: JSON.stringify({
    roomCode: 'F7OK', revision: 10, hostId: ids[0], removed: [], game,
    players: ids.map(id => ({ id, name: id, connected: false })),
  }) });
  const sockets: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    const host = await connect(ids[0]); sockets.push(host);
    const watcher = await connect('guest_evidence'); sockets.push(watcher);
    await expect.poll(() => host.state()?.game?.id).toBe(game.id);
    expect(host.state().game.lastDraw).toEqual({ id: 3, actorId: ids[2], card: { type: 'number', value: 3 } });
    host.send({ type: 'hit', gameId: game.id, revision: host.state().revision });
    await expect.poll(() => watcher.state()?.game.pending?.type).toBe('flipThree');
    expect(watcher.state().game.events.at(-1)).toMatchObject({ type: 'actionDrawn', card: { type: 'flipThree' } });
    expect(watcher.state().game.lastDraw).toEqual({ id: 4, actorId: ids[0], card: { type: 'flipThree' } });
    host.send({ type: 'target', playerId: ids[1], gameId: game.id, revision: host.state().revision });
    await expect.poll(() => watcher.state()?.game.players[1].status).toBe('busted');
    const view = watcher.state().game;
    expect(view.events.map((e: any) => e.type)).toEqual(['actionDrawn', 'actionResolved', 'actionDrawn', 'secondChanceUsed', 'bust']);
    expect(view.players[1]).toMatchObject({ numbers: [2], bustCard: { type: 'number', value: 2 }, roundScore: 0 });
    expect(JSON.stringify(view)).not.toContain('"value":12');
    const saved: any = await (await room.fetch('https://test/__state')).json();
    expect(saved.game.events).toEqual(view.events);
    expect(view.lastDraw).toEqual({ id: 7, actorId: ids[1], card: { type: 'number', value: 2 } });
    expect(saved.game.lastDraw).toEqual(view.lastDraw);
    expect(saved.game.players[1].bustCard).toEqual(view.players[1].bustCard);
    const rejoined = await connect(ids[1]); sockets.push(rejoined);
    await expect.poll(() => rejoined.state()?.game).toEqual(view);
    expect(host.state().game).toEqual(view);
  } finally {
    for (const c of sockets) { try { c.ws.close(); } catch { /* closed */ } }
  }
}, 30_000);
