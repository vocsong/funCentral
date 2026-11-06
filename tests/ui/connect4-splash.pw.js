// Splash/art checks against an isolated local Worker. The ranked sidebar case
// seeds a display fixture; it is not evidence of a completed ranked game.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
let worker;
test.beforeAll(async () => { worker = await startWorker(4225); });
test.afterAll(async () => { await worker?.stop(); });

async function pageFor(browser, viewport, token) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 900, isMobile: viewport.width < 900 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
  if (token) await page.addInitScript(token => localStorage.setItem('authToken', token), token);
  return { context, page, errors };
}
async function artIsValid(page, selector) {
  const art = await page.locator(selector).evaluate(board => {
    const cells = [...board.children];
    const occupied = cell => !!cell && (cell.classList.contains('red') || cell.classList.contains('yellow'));
    const floating = [];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 7; col++) {
      if (cells[row * 7 + col] && occupied(cells[row * 7 + col]) && !occupied(cells[(row + 1) * 7 + col])) floating.push([row, col]);
    }
    return { cells: cells.length, columns: getComputedStyle(board).gridTemplateColumns.split(' ').length, discs: cells.filter(occupied).length, floating };
  });
  expect(art.cells).toBe(42);
  expect(art.columns).toBe(7);
  expect(art.discs).toBeGreaterThan(0);
  expect(art.floating).toEqual([]);
}
async function fits(page, selector) {
  const bad = await page.locator(selector).evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1);
  }).map(element => element.className));
  expect(bad).toEqual([]);
}

for (const viewport of [
  { width: 320, height: 740 }, { width: 390, height: 844 },
  { width: 490, height: 900 }, { width: 768, height: 1024 }, { width: 1366, height: 900 },
]) {
  test(`updated hub and Connect 4 splash fit with gravity-valid art at ${viewport.width}px`, async ({ browser }) => {
    const { page, context, errors } = await pageFor(browser, viewport);
    try {
      await page.goto(worker.origin);
      await expect(page.locator('.hub-lede')).toContainText('Four games');
      await expect(page.locator('.hub-games .game-tile')).toHaveCount(4);
      await expect(page.locator('.hub-games a[href="/connect4/"]')).toHaveCount(1);
      await artIsValid(page, '.tile-connect4-rack');
      await fits(page, '.hub, .hub-hero, .hub-games, .game-tile, .tile-art, .tile-connect4-rack, .tile-btn');
      const cards = await page.locator('.game-tile').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().top));
      if (viewport.width >= 1100) expect(new Set(cards).size).toBe(1);
      await page.screenshot({ path: test.info().outputPath('hub.png'), fullPage: true });
      await page.locator('.hub-games a[href="/connect4/"]').click();
      await expect(page.locator('#login-section')).toBeVisible();
      await expect(page.locator('.c4-feature-chips li')).toHaveCount(3);
      await artIsValid(page, '.c4-hero-board');
      await fits(page, '.c4-home-wrap, .c4-home, .c4-hero-board, .c4-feature-chips, .c4-home-links');
      await page.screenshot({ path: test.info().outputPath('connect4-splash.png'), fullPage: true });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

for (const viewport of [{ width: 320, height: 740 }, { width: 1366, height: 900 }]) {
  test(`signed-in splash keeps create/join and four leaderboard tabs usable at ${viewport.width}px`, async ({ browser }) => {
    const response = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: `Splash Tester ${viewport.width}` }) });
    const { token, telegramId } = await response.json();
    await worker.db.prepare('INSERT OR REPLACE INTO connect4_ratings (telegram_id, rating, games_played, wins, updated_at) VALUES (?, 1000, 1, 1, 0)').bind(telegramId).run();
    const { page, context, errors } = await pageFor(browser, viewport, token);
    try {
      await page.goto(`${worker.origin}/connect4/`);
      await expect(page.locator('#game-section')).toBeVisible();
      await expect(page.locator('#input-name')).toHaveValue(`Splash Tester ${viewport.width}`);
      await expect(page.locator('#leaderboard-section .lb-tab')).toHaveCount(4);
      await expect(page.locator('.lb-tab[data-game="connect4"]')).toHaveAttribute('aria-pressed', 'true');
      await fits(page, '.c4-home-wrap, .c4-home, .c4-join-row, .c4-home-board, .lb-card, .lb-tabs');
      await page.locator('.lb-tab[data-game="bridge"]').click();
      await expect(page.locator('.lb-tab[data-game="bridge"]')).toHaveAttribute('aria-pressed', 'true');
      await page.locator('.lb-tab[data-game="connect4"]').click();
      await page.screenshot({ path: test.info().outputPath('signed-in-splash.png'), fullPage: true });
      await page.locator('#btn-create').click();
      await expect(page.locator('#screen-lobby')).toHaveClass(/active/);
      await expect(page.locator('.c4-player')).toHaveCount(1);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
