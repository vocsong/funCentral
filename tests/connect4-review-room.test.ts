// Real workerd lifecycle/fault tests. Only opening timers and legacy/idle states
// are fixtures; authoritative join/drop/leave and completion/outbox code are real.
import { describe, expect, it } from 'vitest';
import { createConnect4RoomHarness, connectSocket, fireAlarm, readRoom, finishFixtureRound, Response } from './connect4-room-harness';
type Harness = Awaited<ReturnType<typeof createConnect4RoomHarness>>;
type Room = Awaited<ReturnType<Harness['room']>>;
const save = (room: Room, state: unknown) => room.fetch('https://room.test/__state', { method: 'POST', body: JSON.stringify(state) });
async function create(harness: Harness, name: string) {
  const room = await harness.room(name);
  await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'RVW1' }) });
  const host = await connectSocket(room, 'tg_1', 'Alice');
  host.send({ type: 'join', name: 'Alice' });
  await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
  return { room, host };
}
async function fastStart(room: Room, host: Awaited<ReturnType<typeof connectSocket>>) {
  host.send({ type: 'start' });
  await expect.poll(async () => (await readRoom(room)).state.game?.phase).toBe('play');
  const { state } = await readRoom(room);
  state.openingUntil = 0; // fixture: omit cosmetic reveal delay in runtime fault tests
  await save(room, state);
}
async function humanGame(harness: Harness, name: string) {
  const { room, host } = await create(harness, name);
  const guest = await connectSocket(room, 'tg_2', 'Bob');
  guest.send({ type: 'join', name: 'Bob' });
  await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
  await fastStart(room, host);
  return { room, host, guest };
}
async function finish(room: Room, host: Awaited<ReturnType<typeof connectSocket>>, guest: Awaited<ReturnType<typeof connectSocket>>) {
  const opener = (await readRoom(room)).state.game.currentSeat;
  for (let i = 0; i < 7; i++) {
    const seat = i % 2 ? 1 - opener : opener;
    (seat === 0 ? host : guest).send({ type: 'drop', col: i % 2 });
    await expect.poll(async () => (await readRoom(room)).state.game.moveCount).toBe(i + 1);
  }
}

describe('Connect 4 host and adversarial socket regressions', () => {
  it.each([false, true])('explicit leave clears bot-only roster, including after completion (%s), and survives reload', async (completed) => {
    const harness = await createConnect4RoomHarness();
    try {
      let { room, host } = await create(harness, 'bot-host');
      host.send({ type: 'addBot' });
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
      if (completed) { await fastStart(room, host); await finishFixtureRound(room); }
      host.send({ type: 'leave' });
      await expect.poll(async () => (await readRoom(room)).state.players).toEqual([]);
      expect((await readRoom(room)).state.hostId).toBeNull();
      host.socket.close();
      await harness.restart();
      room = await harness.room('bot-host');
      const next = await connectSocket(room, 'tg_3', 'Cat');
      next.send({ type: 'join', name: 'Cat' });
      await expect.poll(async () => (await readRoom(room)).state.hostId).toBe('tg_3');
      next.send({ type: 'addBot' });
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
      const botId = (await readRoom(room)).state.players[1].id;
      next.send({ type: 'kick', playerId: botId });
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
      next.send({ type: 'addBot' });
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
      await fastStart(room, next);
      next.socket.close();
    } finally { await harness.stop(); }
  }, 15000);

  it.each([false, true])('repairs a persisted bot-host room on load (human present: %s)', async (human) => {
    const harness = await createConnect4RoomHarness();
    try {
      const { room, host } = await create(harness, 'legacy-host');
      const { state } = await readRoom(room);
      state.players = [{ id: 'bot_old', isBot: true, name: 'Bot', connected: true, telegramId: null }, ...(human ? state.players : [])];
      state.hostId = 'bot_old';
      await save(room, state);
      host.socket.close();
      await harness.restart();
      const restored = await harness.room('legacy-host');
      const visitor = await connectSocket(restored, 'tg_3', 'Cat');
      await expect.poll(async () => (await readRoom(restored)).state.hostId).toBe(human ? 'tg_1' : null);
      expect((await readRoom(restored)).state.players).toHaveLength(human ? 2 : 0);
      visitor.socket.close();
    } finally { await harness.stop(); }
  }, 15000);

  it('human handoff, disconnect/replacement and malformed/duplicate messages preserve authority', async () => {
    const harness = await createConnect4RoomHarness();
    try {
      const { room, host, guest } = await humanGame(harness, 'socket-chaos');
      const before = (await readRoom(room)).state;
      for (const payload of ['not json', 'null', '[]', '42', '{}', '{"type":null}']) host.socket.send(payload);
      for (let i = 0; i < 15; i++) guest.send({ type: 'start' });
      guest.send({ type: 'drop', col: -1 });
      guest.send({ type: 'drop', col: '3' });
      host.send({ type: 'setColour', colour: 99 });
      // A replaced socket must not disconnect its replacement or duplicate seats.
      const replacement = await connectSocket(room, 'tg_1', 'Alice');
      for (let i = 0; i < 12; i++) replacement.send({ type: 'join', name: 'forged' });
      await expect.poll(async () => (await readRoom(room)).state.players[0].connected).toBe(true);
      const after = (await readRoom(room)).state;
      expect(after.game).toEqual(before.game);
      expect(after.gameNo).toBe(before.gameNo);
      expect(after.players.map((p: any) => p.id)).toEqual(['tg_1', 'tg_2']);
      expect(after.players[0].name).toBe('Alice');
      replacement.socket.close();
      await expect.poll(async () => (await readRoom(room)).state.players[0].connected).toBe(false);
      expect((await readRoom(room)).state.hostId).toBe('tg_1'); // disconnect is NOT explicit leave
      const rejoined = await connectSocket(room, 'tg_1', 'Alice');
      await finishFixtureRound(room);
      rejoined.send({ type: 'leave' });
      await expect.poll(async () => (await readRoom(room)).state.hostId).toBe('tg_2');
      rejoined.socket.close(); guest.socket.close();
    } finally { await harness.stop(); }
  }, 15000);
});

describe('Connect 4 durable outbox chaos', () => {
  it('two distinct room objects crossing game 30 recompute shared ratings', async () => {
    let arrivals = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    const harness = await createConnect4RoomHarness({
      gateRatingRead: true,
      outbound: async () => {
        if (++arrivals === 2) release();
        await bothRead;
        return new Response('read gate');
      },
    });
    try {
      await harness.db.prepare('INSERT INTO connect4_ratings (telegram_id, rating, games_played, updated_at) VALUES (1, 1000, 29, 0), (2, 1000, 29, 0)').run();
      const rooms = [await humanGame(harness, 'cross-room-a'), await humanGame(harness, 'cross-room-b')];
      for (const match of rooms) {
        const { state } = await readRoom(match.room);
        state.game.currentSeat = 0; // fixture: make both exact outcomes identical
        await save(match.room, state);
      }
      await Promise.all(rooms.map(({ room, host, guest }) => finish(room, host, guest)));
      for (const match of rooms) await expect.poll(async () => (await readRoom(match.room)).state.pendingRatings?.length).toBe(0);
      expect(arrivals).toBe(3);
      expect(await harness.db.prepare('SELECT rating, games_played FROM connect4_ratings WHERE telegram_id = 1').first()).toEqual({ rating: 1012, games_played: 31 });
      expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM connect4_games').first('n')).toBe(2);
      for (const { host, guest } of rooms) { host.socket.close(); guest.socket.close(); }
    } finally { release(); await harness.stop(); }
  }, 20000);

  it('a delayed rating acknowledgement cannot clobber a newer round or disconnect', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acknowledgements = 0;
    const harness = await createConnect4RoomHarness({
      gateRatingAck: true,
      outbound: async () => {
        if (++acknowledgements === 1) await held;
        return new Response('ack');
      },
    });
    try {
      const { room, host, guest } = await humanGame(harness, 'delayed-ack');
      await finish(room, host, guest);
      const finishedId = (await readRoom(room)).state.gameId;
      await expect.poll(() => acknowledgements).toBe(1);
      host.send({ type: 'backToLobby' });
      await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
      await fastStart(room, host);
      const nextId = (await readRoom(room)).state.gameId;
      guest.socket.close();
      await expect.poll(async () => (await readRoom(room)).state.players[1].connected).toBe(false);
      release();
      await expect.poll(async () => (await readRoom(room)).state.pendingRatings?.length).toBe(0);
      const { state } = await readRoom(room);
      expect(state.gameId).toBe(nextId);
      expect(state.gameNo).toBe(2);
      expect(state.game.phase).toBe('play');
      expect(state.game.moveCount).toBe(0);
      expect(state.players[1].connected).toBe(false);
      expect(state.lastRating.gameId).toBe(finishedId);
      expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM connect4_games').first('n')).toBe(1);
      host.socket.close();
    } finally { release(); await harness.stop(); }
  }, 15000);

  it.each(['late rollback', 'lost acknowledgement'])('%s survives runtime restart and idle cleanup, then applies exactly once', async (fault) => {
    let broken = true;
    const harness = await createConnect4RoomHarness({
      gateRatingAck: fault === 'lost acknowledgement',
      outbound: async () => new Response('test ack', { status: broken ? 503 : 200 }),
    });
    try {
      if (fault === 'late rollback') await harness.db.prepare("CREATE TRIGGER reject_result BEFORE INSERT ON connect4_games BEGIN SELECT RAISE(ABORT, 'injected late rating failure'); END").run();
      let { room, host, guest } = await humanGame(harness, 'outbox-chaos');
      await finish(room, host, guest);
      await expect.poll(async () => (await readRoom(room)).state.pendingRatings?.length).toBe(1);
      // Repeating valid and invalid client messages must not enqueue duplicates.
      for (let i = 0; i < 5; i++) host.send({ type: 'drop', col: 0 });
      host.send({ type: 'backToLobby' });
      await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
      expect((await readRoom(room)).state.pendingRatings).toHaveLength(1);
      host.socket.close(); guest.socket.close();
      await harness.restart();
      room = await harness.room('outbox-chaos');
      const { state } = await readRoom(room);
      expect(state.pendingRatings).toHaveLength(1);
      state.players = []; state.hostId = null; state.idleSince = Date.now() - 31 * 60 * 1000;
      await save(room, state);
      await fireAlarm(room);
      expect((await readRoom(room)).state.pendingRatings).toHaveLength(1); // do NOT purge unresolved results
      expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM connect4_games').first('n')).toBe(fault === 'late rollback' ? 0 : 1);
      if (fault === 'late rollback') await harness.db.prepare('DROP TRIGGER reject_result').run();
      broken = false;
      await fireAlarm(room);
      expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM connect4_games').first('n')).toBe(1);
      expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM connect4_rating_history').first('n')).toBe(2);
      expect((await harness.db.prepare('SELECT games_played FROM connect4_ratings').all()).results.map((r) => r.games_played)).toEqual([1, 1]);
      await fireAlarm(room);
      expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM connect4_games').first('n')).toBe(1);
    } finally { await harness.stop(); }
  }, 20000);
});
