// Bridge seasons in the browser. The local clock is pinned inside Season 2
// (TEST_NOW_MS, dev-only): the Bridge board shows the fresh season with
// provisional players, Season 1 stays viewable as the final board, the stats
// screen switches seasons and the bot's group board names the season.
const { test, expect } = require('@playwright/test');
const { Response: MfResponse } = require('miniflare');
const { startWorker, webhookHeaders } = require('./live-worker.cjs');
test.setTimeout(120000);

const SEASON_2_START = Date.parse('2026-12-01T00:00:00+08:00');
const sent = [];
let worker;

async function run(sql, ...binds) {
  await worker.db.prepare(sql).bind(...binds).run();
}

test.beforeAll(async () => {
  worker = await startWorker(4232, { TELEGRAM_BOT_TOKEN: 'test-token', TEST_NOW_MS: String(SEASON_2_START + 3_600_000) }, {
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'api.telegram.org') return new MfResponse('blocked in tests', { status: 502 });
      sent.push({ method: url.pathname.split('/').pop(), body: await request.json().catch(() => ({})) });
      return MfResponse.json({ ok: true, result: { status: 'member' } });
    },
  });
  // Season 1 (legacy Elo): Lee leads. Season 2 (fresh): Sam and Fay, both provisional.
  for (const [id, name, elo, wins, games] of [[201, 'Legacy Lee', 1100, 20, 30], [202, 'Season Sam', 990, 1, 2], [203, 'Fresh Fay', 1000, 0, 0]]) {
    await run('INSERT INTO users (telegram_id, display_name, created_at, wins, games_played, elo) VALUES (?, ?, 0, ?, ?, ?)', id, name, wins, games, elo);
  }
  await run("INSERT INTO groups (group_id, group_name, created_at) VALUES ('-1001', 'Card Club', 0)");
  await run("INSERT INTO group_stats (group_id, telegram_id, wins, games_played) VALUES ('-1001', 201, 20, 30)");
  await run("INSERT INTO bridge_ratings (system, telegram_id, rating, games, wins, updated_at) VALUES ('season-2', 202, 1030.4, 3, 2, 0), ('season-2', 203, 1009.6, 3, 1, 0)");
  await run("INSERT INTO bridge_season_group_stats (season_id, group_id, telegram_id, wins, games_played) VALUES (2, '-1001', 202, 2, 3), (2, '-1001', 203, 1, 3)");
  for (let hand = 1; hand <= 3; hand++) {
    // Three Season 1 hands for Lee, three Season 2 hands for Sam and Fay.
    await run("INSERT INTO game_records (game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id) VALUES (?, '-1001', 1, 201, 'bidder', 1, 1, '♠', 7, NULL)", `s1-${hand}`);
    await run("INSERT INTO bridge_game_ledger (game_id, season_id, room_code, status, is_practice, has_bot, has_replacement, redeal_count, tricks_played, skill_applied, completed_at) VALUES (?, 2, 'ROOM', 'completed', 0, 0, 0, 0, 13, 1, 2)", `s2-${hand}`);
    for (const id of [202, 203]) {
      await run("INSERT INTO game_records (game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id) VALUES (?, '-1001', 2, ?, 'opposition', ?, 1, '♠', 7, NULL)", `s2-${hand}`, id, id === 202 || hand === 1 ? 1 : 0);
    }
  }
});
test.afterAll(async () => { await worker?.stop(); });

test('Season 2 is fresh with provisional players; Season 1 stays viewable as the final board', async ({ browser }) => {
  const origin = worker.origin;
  const board = await (await fetch(`${origin}/api/leaderboard`)).json();
  expect(board.season).toEqual({ id: 2, name: 'Season 2', current: true });
  expect(board.seasons.map((s) => s.id)).toEqual([2, 1]);
  expect(board.top.map((e) => [e.displayName, e.elo, e.gamesPlayed, e.provisional])).toEqual([['Season Sam', 1030, 3, true], ['Fresh Fay', 1010, 3, true]]);
  const finalBoard = await (await fetch(`${origin}/api/leaderboard?season=1`)).json();
  expect(finalBoard.season).toEqual({ id: 1, name: 'Season 1', current: false });
  expect(finalBoard.top.map((e) => [e.displayName, e.elo])).toEqual([['Legacy Lee', 1100], ['Season Sam', 990]]);

  await fetch(`${origin}/api/telegram`, { method: 'POST', headers: webhookHeaders, body: JSON.stringify({ message: { chat: { id: -1001, type: 'group', title: 'Card Club' }, from: { id: 5, username: 'ana' }, text: '/leaderboard' } }) });
  await expect.poll(() => sent.filter((c) => c.method === 'sendMessage').length).toBe(1);
  const post = sent.find((c) => c.method === 'sendMessage').body.text;
  expect(post).toContain('Bridge · Season 2');
  expect(post).toContain('Season Sam — Rating 1030 (2W / 3G, provisional)');

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.goto(`${origin}/bridge/`);
    const card = page.locator('#leaderboard-section .lb-card');
    await expect(card.locator('.lb-season.active')).toHaveText('Season 2');
    await expect(card.locator('.lb-row').first()).toContainText('Season Sam');
    await expect(card.locator('.lb-provisional')).toHaveCount(2);
    const cardBox = await card.boundingBox();
    const switchBox = await card.locator('.lb-seasons').boundingBox();
    expect(switchBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);

    await card.locator('.lb-season', { hasText: 'Season 1' }).click();
    await expect(card.locator('.lb-season.active')).toHaveText('Season 1 (final)');
    await expect(card.locator('.lb-row').first()).toContainText('Legacy Lee');
    await expect(card.locator('.lb-provisional')).toHaveCount(0);

    await card.getByRole('button', { name: /Full stats/ }).click();
    const season = page.locator('#stats-season-select');
    await expect(season).toBeVisible();
    await expect(season.locator('option')).toHaveText(['Season 2', 'Season 1 (final)']);
    const table = page.locator('#screen-stats');
    await expect(table).toContainText('Season Sam');
    await expect(table).toContainText('1030');
    await expect(table).not.toContainText('Legacy Lee');
    await season.selectOption({ label: 'Season 1 (final)' });
    await expect(table).toContainText('Legacy Lee');
    await expect(table).not.toContainText('Season Sam');
    expect(errors).toEqual([]);
    await context.close();
  }
});
