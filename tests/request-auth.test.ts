// Router authentication boundaries, exercised through the real Worker fetch handler.
// Room classes need workerd, so their modules are replaced with inert exports; the
// router never constructs them. JWTs use the real signing/verification helpers with
// synthetic secrets, and every Telegram side effect is a local spy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signJwt } from '../src/auth';
import type { Env } from '../src/types';

vi.mock('../src/game-room', () => ({ GameRoom: class {} }));
vi.mock('../src/regicide/room', () => ({ RegicideRoom: class {} }));
vi.mock('../src/taidi/room', () => ({ TaiDiRoom: class {} }));
vi.mock('../src/connect4/room', () => ({ Connect4Room: class {} }));
vi.mock('../src/omok/room', () => ({ OmokRoom: class {} }));

const JWT_SECRET = 'request-auth-test-only';
const WEBHOOK_SECRET = 'local-webhook-test-only';
const ORIGIN = 'https://funcentral.test';

type Handler = { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };
let worker: Handler;
let outbound: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // A fresh module per test resets the once-per-instance bot command registration.
  vi.resetModules();
  worker = (await import('../src/index')).default as unknown as Handler;
  outbound = vi.fn(async () => Response.json({ ok: true, result: true }));
  vi.stubGlobal('fetch', outbound);
});
afterEach(() => { vi.unstubAllGlobals(); });

function harness(bindings: Partial<Env> = {}) {
  const forwarded: Request[] = [];
  const namespace = () => ({
    getByName: vi.fn(() => ({
      fetch: vi.fn(async (request: Request) => { forwarded.push(request); return new Response('room'); }),
    })),
  });
  const db = { prepare: vi.fn(() => { throw new Error('D1 must not be touched'); }), batch: vi.fn() };
  const env = {
    GAME_ROOM: namespace(), REGICIDE_ROOM: namespace(), TAIDI_ROOM: namespace(), CONNECT4_ROOM: namespace(), OMOK_ROOM: namespace(),
    DB: db, JWT_SECRET, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_BOT_USERNAME: 'local_test_only', ...bindings,
  } as unknown as Env;
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const rooms = () => [env.GAME_ROOM, env.REGICIDE_ROOM, env.TAIDI_ROOM, env.CONNECT4_ROOM, env.OMOK_ROOM]
    .flatMap((ns) => (ns as unknown as { getByName: ReturnType<typeof vi.fn> }).getByName.mock.calls);
  return { env, ctx, db, forwarded, rooms };
}

const token = (sub: string, { secret = JWT_SECRET, ttl = 3600 } = {}) =>
  signJwt({ sub, name: `Player ${sub}`, exp: Math.floor(Date.now() / 1000) + ttl }, secret);

describe('Bridge /api/ws identity', () => {
  async function connect(query: string, bindings: Partial<Env> = {}) {
    const h = harness(bindings);
    const request = new Request(`${ORIGIN}/api/ws?${query}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGVzdC1rZXktMTIzNDU2Nw==' } });
    const response = await worker.fetch(request, h.env, h.ctx);
    expect(h.forwarded).toHaveLength(1);
    const forwarded = h.forwarded[0];
    return { ...h, response, forwarded, url: new URL(forwarded.url) };
  }

  it.each([
    ['missing', 'room=ABCD&playerId=tg_12345'],
    ['empty', 'room=ABCD&playerId=tg_12345&token='],
    ['malformed', 'room=ABCD&playerId=tg_12345&token=not.a.jwt'],
  ])('a %s token cannot claim a registered identity', async (_label, query) => {
    const { url } = await connect(query, { ALLOW_DEV_LOGIN: '1' });
    expect(url.searchParams.get('playerId')).toBe('guest_tg12345');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('a wrong-key or expired JWT cannot claim a registered identity, and is not forwarded', async () => {
    for (const credential of [await token('12345', { secret: 'some-other-key' }), await token('12345', { ttl: -60 })]) {
      const { url } = await connect(`room=ABCD&playerId=tg_12345&token=${encodeURIComponent(credential)}`);
      expect(url.searchParams.get('playerId')).toBe('guest_tg12345');
      expect(url.searchParams.has('token')).toBe(false);
    }
  });

  it('a valid JWT sets the identity from its signed subject only', async () => {
    const credential = await token('777');
    const { url, response } = await connect(`room=ABCD&playerId=tg_999&token=${encodeURIComponent(credential)}`);
    expect(await response.text()).toBe('room');
    expect(url.searchParams.get('playerId')).toBe('tg_777');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('keeps a guest browser id stable across reconnects and bounds it', async () => {
    const first = await connect('room=ABCD&playerId=0f4c-Guest_<script>');
    const second = await connect('room=ABCD&playerId=0f4c-Guest_<script>');
    expect(first.url.searchParams.get('playerId')).toBe('guest_0f4c-Guestscript');
    expect(second.url.searchParams.get('playerId')).toBe(first.url.searchParams.get('playerId'));
    const long = await connect(`room=ABCD&playerId=${'a'.repeat(200)}`);
    expect(long.url.searchParams.get('playerId')).toBe(`guest_${'a'.repeat(64)}`);
  });

  it('generates a usable guest id when none (or nothing usable) is supplied', async () => {
    for (const query of ['room=ABCD', 'room=ABCD&playerId=', 'room=ABCD&playerId=___']) {
      const { url } = await connect(query);
      expect(url.searchParams.get('playerId')).toMatch(/^guest_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('preserves the room and WebSocket upgrade request', async () => {
    const { forwarded, url, env } = await connect('room=WXYZ&playerId=abc');
    expect((env.GAME_ROOM as unknown as { getByName: ReturnType<typeof vi.fn> }).getByName).toHaveBeenCalledWith('WXYZ');
    expect(url.pathname).toBe('/api/ws');
    expect(url.searchParams.get('room')).toBe('WXYZ');
    expect(forwarded.method).toBe('GET');
    expect(forwarded.headers.get('Upgrade')).toBe('websocket');
    expect(forwarded.headers.get('Sec-WebSocket-Key')).toBe('dGVzdC1rZXktMTIzNDU2Nw==');
  });

  it('still rejects a missing room before touching any room', async () => {
    const h = harness();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/ws?playerId=tg_1`), h.env, h.ctx);
    expect(response.status).toBe(400);
    expect(h.rooms()).toHaveLength(0);
  });
});

describe('Telegram /api/telegram webhook authentication', () => {
  const update = (text: string) => JSON.stringify({
    message: { chat: { id: -100123, type: 'supergroup', title: 'Card Club' }, from: { id: 42, username: 'ana' }, text },
  });
  const post = (headers: Record<string, string> = {}, text = '/newbridge') =>
    new Request(`${ORIGIN}/api/telegram`, { method: 'POST', headers, body: update(text) });

  it.each([
    ['absent', 503, {}, {}],
    ['empty', 503, { TELEGRAM_WEBHOOK_SECRET: '' }, { 'X-Telegram-Bot-Api-Secret-Token': '' }],
    ['configured, header missing', 401, { TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }, {}],
    ['configured, header mismatched', 401, { TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }],
    ['configured, header differs in case', 401, { TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }, { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET.toUpperCase() }],
  ])('secret %s → %i before reading the update or any side effect', async (_label, status, bindings, headers) => {
    // Dev login must not create a bypass.
    const h = harness({ ALLOW_DEV_LOGIN: '1', ...bindings });
    const request = post(headers);
    const response = await worker.fetch(request, h.env, h.ctx);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(WEBHOOK_SECRET);
    expect(request.bodyUsed).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
    expect(h.ctx.waitUntil).not.toHaveBeenCalled();
    expect(h.db.prepare).not.toHaveBeenCalled();
    expect(h.rooms()).toHaveLength(0);
  });

  it('processes a legitimate command when the header matches', async () => {
    const h = harness({ TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const request = post({ 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET }, '/help');
    const response = await worker.fetch(request, h.env, h.ctx);
    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(true);
    expect(h.ctx.waitUntil).toHaveBeenCalledTimes(1); // command menu registration
    await Promise.all((h.ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => p));
    const methods = outbound.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/').pop());
    expect(methods).toEqual(expect.arrayContaining(['setMyCommands', 'sendMessage']));
    const sent = outbound.mock.calls.find(([url]) => String(url).endsWith('/sendMessage'))!;
    expect(JSON.parse((sent[1] as RequestInit).body as string)).toMatchObject({ chat_id: '-100123' });
  });
});
