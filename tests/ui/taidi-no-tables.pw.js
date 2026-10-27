// Production may deploy before the Tai Di migration runs. Prove that is safe: with the
// Tai Di tables missing, games still play to the end and Bridge (incl. the bot) is unaffected.
const { test, expect } = require('@playwright/test');
const { Response: MfResponse } = require('miniflare');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(120000);

const sent = [];
let worker;
test.beforeAll(async () => {
  worker = await startWorker(4223, { TELEGRAM_BOT_TOKEN: 'test-token' }, {
    skipMigrations: ['0012_taidi.sql'],
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'api.telegram.org') return new MfResponse('blocked in tests', { status: 502 });
      sent.push({ method: url.pathname.split('/').pop(), body: await request.json().catch(() => ({})) });
      return MfResponse.json({ ok: true, result: { status: 'member' } });
    },
  });
});
test.afterAll(async () => { await worker?.stop(); });

test('without the Tai Di tables: Tai Di still plays, boards are empty, Bridge is untouched', async ({ browser }) => {
  const tables = await worker.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'taidi_%'").all();
  expect(tables.results).toEqual([]);

  // Tai Di APIs answer "nothing yet" instead of erroring.
  expect(await (await fetch(`${worker.origin}/api/taidi/leaderboard`)).json()).toEqual({ top: [], me: null });
  expect(await (await fetch(`${worker.origin}/api/taidi/stats`)).json()).toEqual([]);

  // The bot's /leaderboard still posts Bridge's board.
  await fetch(`${worker.origin}/api/telegram`, { method: 'POST', body: JSON.stringify({ message: { chat: { id: -1009, type: 'group', title: 'G' }, from: { id: 5, username: 'ana' }, text: '/leaderboard' } }) });
  await expect.poll(() => sent.filter((c) => c.method === 'sendMessage').length).toBe(1);
  expect(sent.find((c) => c.method === 'sendMessage').body.text).toContain('No games played in this group yet');

  // A two-player game runs to the end; the game-over panel just has no rating section.
  const login = async (displayName) => (await (await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName }) })).json()).token;
  const { roomCode } = await (await fetch(`${worker.origin}/api/taidi/create`, { method: 'POST', body: '{"seed":5}' })).json();
  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    const t = await login(name);
    await page.addInitScript((value) => localStorage.setItem('authToken', value), t);
    await page.goto(`${worker.origin}/taidi/#${roomCode}`);
    return { page, context, errors };
  };
  const a = await open('No Table Ann');
  const b = await open('No Table Ben');
  await expect(a.page.locator('#lobby-players .td-player')).toHaveCount(2);
  await a.page.locator('#btn-start').click();
  await expect(a.page.locator('#screen-game')).toHaveClass(/active/);
  await fetch(`${worker.origin}/api/taidi/debug/patch?room=${roomCode}`, { method: 'POST', body: JSON.stringify({
    hands: [['KS'], ['3C', '5D']], currentSeat: 0, table: null, mustInclude: null }) });
  await a.page.evaluate(() => send({ type: 'play', cards: ['KS'] }));
  await expect(a.page.locator('#over-title')).toContainText('You win');
  await expect(a.page.locator('#over-rating')).toBeHidden();
  await a.page.locator('#btn-again').click();
  await expect(a.page.locator('#screen-lobby')).toHaveClass(/active/);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.context.close();
  await b.context.close();

  // Bridge still creates rooms as usual.
  expect((await fetch(`${worker.origin}/api/create`, { method: 'POST', body: '{}' })).ok).toBe(true);
});
