import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnect4RoomHarness, connectSocket, finishFixtureRound, readRoom } from './connect4-room-harness';

type Harness = Awaited<ReturnType<typeof createConnect4RoomHarness>>;
let harness: Harness;

async function table(name: string) {
  const room = await harness.room(name);
  await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'CLR1' }) });
  const host = await connectSocket(room, 'tg_10', 'Ada');
  host.send({ type: 'join', name: 'Ada' });
  await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
  const guest = await connectSocket(room, 'tg_20', 'Bea');
  guest.send({ type: 'join', name: 'Bea' });
  await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
  return { room, host, guest };
}

async function rejects(client: Awaited<ReturnType<typeof connectSocket>>, message: unknown, text: string) {
  const before = client.frames.filter(frame => frame.type === 'error').length;
  client.send(message);
  await expect.poll(() => client.frames.filter(frame => frame.type === 'error').length).toBe(before + 1);
  expect(client.frames.filter(frame => frame.type === 'error').at(-1).message).toContain(text);
}

describe('Connect 4 cosmetic colours (live workerd)', () => {
  beforeAll(async () => { harness = await createConnect4RoomHarness(); }, 30000);
  afterAll(async () => { await harness?.stop(); });

  it('publishes defaults, allows exactly three choices per player, and rejects spectators and mid-game changes', async () => {
    const { room, host, guest } = await table('colour-permissions');
    await expect.poll(() => host.frames.filter(frame => frame.type === 'state').at(-1)?.players.length).toBe(2);
    expect(host.frames.filter(frame => frame.type === 'state').at(-1).players.map((player: any) => player.colour)).toEqual([0, 0]);
    for (const colour of [1, 2, 0]) {
      host.send({ type: 'setColour', colour });
      guest.send({ type: 'setColour', colour });
      await expect.poll(async () => (await readRoom(room)).state.players.map((player: any) => player.colour)).toEqual([colour, colour]);
    }
    for (const colour of [-1, 3, 1.5, '1', null]) {
      await rejects(host, { type: 'setColour', colour }, 'three disc colours');
    }
    const watcher = await connectSocket(room, 'guest_1', 'Watcher');
    await rejects(watcher, { type: 'setColour', colour: 2 }, 'Take a seat');
    // A forged target cannot change another player: selection is bound to the socket's seat.
    host.send({ type: 'setColour', colour: 2, playerId: 'tg_20', seat: 1 });
    await expect.poll(async () => (await readRoom(room)).state.players.map((player: any) => player.colour)).toEqual([2, 0]);
    guest.send({ type: 'setColour', colour: 1 });
    await expect.poll(async () => (await readRoom(room)).state.players[1].colour).toBe(1);
    await expect.poll(() => watcher.frames.filter(frame => frame.type === 'state').at(-1)?.players.map((player: any) => player.colour)).toEqual([2, 1]);
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
    await rejects(guest, { type: 'setColour', colour: 2 }, 'only be changed in the lobby');
    expect((await readRoom(room)).state.players.map((player: any) => player.colour)).toEqual([2, 1]);
    expect((await readRoom(room)).state.game.board.flat().every((cell: number) => cell === 0)).toBe(true);
  });

  it('retains each player choice through reconnection, cold restart and rematch', async () => {
    let { room, host, guest } = await table('durable-colours');
    host.send({ type: 'setColour', colour: 1 });
    guest.send({ type: 'setColour', colour: 2 });
    await expect.poll(async () => (await readRoom(room)).state.players.map((player: any) => player.colour)).toEqual([1, 2]);
    await harness.restart();
    room = await harness.room('durable-colours');
    host = await connectSocket(room, 'tg_10', 'Ada');
    guest = await connectSocket(room, 'tg_20', 'Bea');
    expect((await readRoom(room)).state.players.map((player: any) => player.colour)).toEqual([1, 2]);
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
    await finishFixtureRound(room);
    host.send({ type: 'backToLobby' });
    await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
    host.send({ type: 'start' });
    await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(2);
    expect((await readRoom(room)).state.players.map((player: any) => player.colour)).toEqual([1, 2]);
    await expect.poll(() => guest.frames.filter(frame => frame.type === 'state').at(-1)?.players.map((player: any) => player.colour)).toEqual([1, 2]);
  });
});
