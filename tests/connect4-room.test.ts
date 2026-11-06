import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnect4RoomHarness, connectSocket, finishFixtureRound, readRoom } from './connect4-room-harness';

type Harness = Awaited<ReturnType<typeof createConnect4RoomHarness>>;
let harness: Harness;

describe('Connect 4 bot room (live workerd)', () => {
  beforeAll(async () => { harness = await createConnect4RoomHarness(); }, 30000);
  afterAll(async () => { await harness?.stop(); });

  it('alternates openers and schedules bot openings and replies without rating practice games', async () => {
    const room = await harness.room('bot-room');
    const created = await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'BOT1' }) });
    expect(created.ok).toBe(true);
    const host = await connectSocket(room, 'tg_1', 'Ann');
    host.send({ type: 'join', name: 'Ann' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
    host.send({ type: 'addBot' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
    expect((await readRoom(room)).state.players[1].isBot).toBe(true);

    const openers: number[] = [];
    for (let round = 1; round <= 2; round++) {
      host.send({ type: 'start' });
      await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(round);
      let { state } = await readRoom(room);
      const opener = 1 - state.nextStartingSeat;
      expect([0, 1]).toContain(opener);
      openers.push(opener);
      expect(state.game.moveCount).toBe(0);
      expect(state.openingUntil).toBeGreaterThan(Date.now());
      if (opener === 1) expect(state.botMoveAt).toBeGreaterThanOrEqual(state.openingUntil + 700);
      await expect.poll(() => Date.now() >= state.openingUntil, { timeout: 5000 }).toBe(true);
      if (opener === 1) {
        // If yellow opens, the bot must move without a human drop first.
        await expect.poll(async () => (await readRoom(room)).state.game.moveCount, { timeout: 5000 }).toBe(1);
        state = (await readRoom(room)).state;
        expect(state.game.log[0].seat).toBe(1);
        expect(state.game.currentSeat).toBe(0);
        expect(state.botMoveAt).toBeNull();
      } else {
        expect(state.game.moveCount).toBe(0);
        expect(state.game.currentSeat).toBe(0);
        expect(state.botMoveAt).toBeNull();
      }
      host.send({ type: 'drop', col: 3 });
      const expectedMoves = opener === 1 ? 3 : 2;
      await expect.poll(async () => (await readRoom(room)).state.game.moveCount, { timeout: 5000 }).toBe(expectedMoves);
      state = (await readRoom(room)).state;
      expect(state.game.currentSeat).toBe(0);
      expect(state.game.log[0].seat).toBe(opener);
      expect(state.botMoveAt).toBeNull();
      expect(state.game.board.flat().filter((cell: number) => cell === 2)).toHaveLength(opener === 1 ? 2 : 1);
      expect(state.pendingRatings).toBeUndefined();
      expect(state.lastRating).toBeNull();
      await finishFixtureRound(room);
      host.send({ type: 'backToLobby' });
      await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
    }
    expect(openers[1]).toBe(1 - openers[0]);
  }, 15000);

  it('preserves the next opener across reconnection and a cold runtime restart', async () => {
    let room = await harness.room('persistent-opener');
    await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'ALT1' }) });
    let host = await connectSocket(room, 'tg_2', 'Bea');
    host.send({ type: 'join', name: 'Bea' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
    host.send({ type: 'addBot' });
    await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
    const { state } = await readRoom(room);
    const next = state.nextStartingSeat;
    expect([0, 1]).toContain(next);
    // A reconnect must not reroll the current game or its successor.
    host = await connectSocket(room, 'tg_2', 'Bea');
    expect((await readRoom(room)).state.nextStartingSeat).toBe(next);
    await finishFixtureRound(room);
    host.send({ type: 'backToLobby' });
    await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
    await harness.restart();
    room = await harness.room('persistent-opener');
    expect((await readRoom(room)).state.nextStartingSeat).toBe(next);
    host = await connectSocket(room, 'tg_2', 'Bea');
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(2);
    expect((await readRoom(room)).state.nextStartingSeat).toBe(1 - next);
    await finishFixtureRound(room);
    host.send({ type: 'backToLobby' });
    await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
  });
});
