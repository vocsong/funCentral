import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnect4RoomHarness, connectSocket, finishFixtureRound, readRoom } from './connect4-room-harness';

type Harness = Awaited<ReturnType<typeof createConnect4RoomHarness>>;
let harness: Harness;

async function rejectReset(client: Awaited<ReturnType<typeof connectSocket>>, message: string) {
  const count = client.frames.filter(frame => frame.type === 'error').length;
  client.send({ type: 'backToLobby' });
  await expect.poll(() => client.frames.filter(frame => frame.type === 'error').length).toBe(count + 1);
  expect(client.frames.filter(frame => frame.type === 'error').at(-1).message).toContain(message);
}

describe('Connect 4 cannot end a round early (live workerd)', () => {
  beforeAll(async () => { harness = await createConnect4RoomHarness(); }, 30000);
  afterAll(async () => { await harness?.stop(); });

  it('rejects early resets, preserves a leaver seat, and permits a rematch only after completion', async () => {
    const room = await harness.room('no-early-end');
    await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'LIFE' }) });
    let host = await connectSocket(room, 'tg_1', 'Ada');
    host.send({ type: 'join', name: 'Ada' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
    const guest = await connectSocket(room, 'tg_2', 'Bea');
    guest.send({ type: 'join', name: 'Bea' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
    const watcher = await connectSocket(room, 'guest_watch', 'Watcher');
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
    const { state } = await readRoom(room);
    const opener = state.game.currentSeat;
    await rejectReset(host, 'Finish the round');
    await rejectReset(guest, 'Finish the round');
    await rejectReset(watcher, 'watching');
    expect((await readRoom(room)).state.gameId).toBe(state.gameId);
    await expect.poll(() => Date.now() >= state.openingUntil, { timeout: 5000 }).toBe(true);
    (opener === 0 ? host : guest).send({ type: 'drop', col: 3 });
    await expect.poll(async () => (await readRoom(room)).state.game.moveCount).toBe(1);
    await rejectReset(host, 'Finish the round');
    host.send({ type: 'leave' });
    await expect.poll(async () => (await readRoom(room)).state.players[0].connected).toBe(false);
    host = await connectSocket(room, 'tg_1', 'Ada');
    const restored = (await readRoom(room)).state;
    expect(restored.players).toHaveLength(2);
    expect(restored.players[0].connected).toBe(true);
    expect(restored.gameId).toBe(state.gameId);
    expect(restored.game.moveCount).toBe(1);
    expect(restored.nextStartingSeat).toBe(1 - opener);

    // Only the completion transition below is a fixture; the separate UI suite
    // also plays a real seven-drop win and uses Play Again afterwards.
    await finishFixtureRound(room);
    await rejectReset(watcher, 'watching');
    guest.send({ type: 'backToLobby' });
    await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(2);
    expect((await readRoom(room)).state.game.currentSeat).toBe(1 - opener);
  }, 15000);
});
