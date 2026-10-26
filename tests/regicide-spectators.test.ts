import { describe, expect, it } from 'vitest';
import { createRegicideHarness } from './regicide-persistence-harness';

type Room = Awaited<ReturnType<Awaited<ReturnType<typeof createRegicideHarness>>['room']>>;

/** Opens a socket as any player id and keeps every frame it receives. */
async function watch(room: Room, playerId: string, name?: string) {
  const query = `playerId=${playerId}${name ? `&name=${name}` : ''}`;
  const ws = (await room.fetch(`https://room.test/?${query}`, { headers: { Upgrade: 'websocket' } })).webSocket!;
  ws.accept();
  const frames: any[] = [];
  ws.addEventListener('message', (event) => frames.push(JSON.parse(event.data as string)));
  const last = () => frames.filter((f) => f.type === 'state').at(-1);
  return { ws, frames, last, send: (msg: unknown) => ws.send(JSON.stringify(msg)) };
}

describe('Regicide spectators (live workerd)', () => {
  it('lists connected watchers to everyone, hides hands, and keeps watchers out of a running game', async () => {
    const worker = await createRegicideHarness();
    const open: { ws: WebSocket }[] = [];
    try {
      const room = await worker.room('spectators');
      const created = await room.fetch('https://room.test/create', { method: 'POST', body: JSON.stringify({ roomCode: 'SPEC', seed: 9 }) });
      expect(created.status).toBe(200);

      const host = await watch(room, 'tg_1', 'Host');
      open.push(host);
      host.send({ type: 'join', name: 'Host' });
      await expect.poll(() => host.last()?.you.seat).toBe(0);
      host.send({ type: 'start' });
      await expect.poll(() => host.last()?.game?.phase).toBe('play');
      expect(host.last().spectators).toEqual([]);

      // A guest opening the link mid-game watches: no seat, no hand, and the table sees them arrive.
      const guest = await watch(room, 'guest_abc');
      open.push(guest);
      await expect.poll(() => host.last()?.spectators).toEqual(['Guest']);
      await expect.poll(() => guest.last()?.game?.phase).toBe('play');
      expect(guest.last().you.seat).toBe(-1);
      expect(guest.last().game.hand).toBeNull();
      expect(guest.last().game.handCounts).toEqual(host.last().game.handCounts);

      // A signed-in watcher is listed by their verified name and cannot join the running game.
      const late = await watch(room, 'tg_2', 'Late');
      open.push(late);
      await expect.poll(() => host.last()?.spectators).toEqual(['Guest', 'Late']);
      late.send({ type: 'join', name: 'Late' });
      await expect.poll(() => late.frames.some((f) => f.type === 'error' && /already started/.test(f.message))).toBe(true);
      late.send({ type: 'play', cards: host.last().game.hand.slice(0, 1) });
      await expect.poll(() => late.frames.some((f) => f.type === 'error' && /watching/.test(f.message))).toBe(true);
      expect(host.last().players.map((p: any) => p.id)).toEqual(['tg_1']);
      expect(JSON.stringify(host.last().spectators)).not.toContain('tg_2');

      // Leaving updates everyone's list.
      guest.ws.close(1000);
      await expect.poll(() => host.last()?.spectators).toEqual(['Late']);
      await expect.poll(() => late.last()?.spectators).toEqual(['Late']);
    } finally {
      for (const { ws } of open) { try { ws.close(1000); } catch {} }
      await worker.stop();
    }
  }, 30000);
});
