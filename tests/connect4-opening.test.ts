import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnect4RoomHarness, connectSocket, readRoom } from './connect4-room-harness';

type Harness = Awaited<ReturnType<typeof createConnect4RoomHarness>>;
let harness: Harness;

describe('Connect 4 opening reveal (live workerd)', () => {
  beforeAll(async () => { harness = await createConnect4RoomHarness(); }, 30000);
  afterAll(async () => { await harness?.stop(); });

  it('gates early drops and preserves the same opener and reveal deadline across cold restart', async () => {
    let room = await harness.room('opening-reveal');
    await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'OPEN' }) });
    let host = await connectSocket(room, 'tg_1', 'Ada');
    host.send({ type: 'join', name: 'Ada' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
    let guest = await connectSocket(room, 'tg_2', 'Bea');
    guest.send({ type: 'join', name: 'Bea' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
    const { state } = await readRoom(room);
    const opener = state.game.currentSeat;
    const finishesAt = state.openingUntil;
    expect(finishesAt).toBeGreaterThan(Date.now());
    await expect.poll(() => guest.frames.filter(frame => frame.type === 'state').at(-1)?.game?.opensAt).toBe(finishesAt);
    const frame = guest.frames.filter(frame => frame.type === 'state').at(-1);
    expect(frame.serverTime).toBeLessThan(finishesAt);
    const first = opener === 0 ? host : guest;
    first.send({ type: 'drop', col: 3 });
    await expect.poll(() => first.frames.filter(frame => frame.type === 'error').at(-1)?.message).toContain('starting-player reveal');
    expect((await readRoom(room)).state.game.moveCount).toBe(0);

    await harness.restart();
    room = await harness.room('opening-reveal');
    const restored = (await readRoom(room)).state;
    expect(restored.openingUntil).toBe(finishesAt);
    expect(restored.game.currentSeat).toBe(opener);
    expect(restored.nextStartingSeat).toBe(1 - opener);
    host = await connectSocket(room, 'tg_1', 'Ada');
    guest = await connectSocket(room, 'tg_2', 'Bea');
    await expect.poll(() => Date.now() >= finishesAt, { timeout: 5000 }).toBe(true);
    (opener === 0 ? host : guest).send({ type: 'drop', col: 3 });
    await expect.poll(async () => (await readRoom(room)).state.game.moveCount).toBe(1);
    expect((await readRoom(room)).state.game.lastMove.seat).toBe(opener);
  }, 15000);
});
