// Reproducible review evidence; not part of the automated test count.
// Uses a real temporary local Worker and legal drops. Never deploys.
const { chromium, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.CONNECT4_SHOTS || path.join(root, 'test-results/connect4-review'));

async function capture() {
  await fs.mkdir(out, { recursive: true });
  const worker = await startWorker(4244);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const metadata = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(), browser: browser.version(), screenshots: [],
  };
  try {
    for (const mobile of [false, true]) {
      const label = mobile ? 'mobile' : 'desktop';
      const viewport = mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 };
      const options = { viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 };
      const contexts = [];
      const errors = [];
      const prepare = async (page) => {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
          const url = new URL(route.request().url());
          return url.origin === worker.origin || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
            ? route.continue() : route.abort();
        });
      };
      try {
        const hubContext = await browser.newContext(options);
        contexts.push(hubContext);
        const hub = await hubContext.newPage();
        await prepare(hub);
        await hub.goto(worker.origin);
        await expect(hub.locator('.game-tile')).toHaveCount(4);
        await hub.evaluate(() => document.fonts.ready);
        // The hub scrolls inside its 100vh body. A root fullPage capture would
        // paint blank pixels below the viewport, so capture actual viewport views.
        await hub.screenshot({ path: path.join(out, `hub-${label}.png`), animations: 'disabled' });
        if (mobile) {
          await hub.locator('.tile-connect4').scrollIntoViewIfNeeded();
          await expect(hub.locator('.tile-connect4')).toBeInViewport();
          await hub.screenshot({ path: path.join(out, 'hub-games-mobile.png'), animations: 'disabled' });
        }
        const { roomCode } = await fetch(`${worker.origin}/api/connect4/create`, { method: 'POST' }).then((r) => r.json());
        const pages = [];
        for (const name of ['Alice', 'Bob']) {
          const context = await browser.newContext(options);
          contexts.push(context);
          const page = await context.newPage();
          await prepare(page);
          const auth = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) }).then((r) => r.json());
          await page.addInitScript((token) => localStorage.setItem('authToken', token), auth.token);
          await page.goto(`${worker.origin}/connect4/#${roomCode}`);
          await expect.poll(() => page.evaluate(() => view?.you.seat)).toBe(pages.length);
          pages.push(page);
        }
        const host = pages[0];
        await expect(host.locator('#lobby-players .c4-player')).toHaveCount(2);
        await expect(host.locator('#btn-start')).toBeEnabled();
        await host.evaluate(() => document.fonts.ready);
        await host.screenshot({ path: path.join(out, `lobby-${label}.png`), animations: 'disabled' });
        await host.locator('#btn-start')[mobile ? 'tap' : 'click']();
        await expect(host.locator('#screen-game')).toHaveClass(/active/);
        for (const col of [3, 2, 3, 4, 2, 3]) {
          const current = await host.evaluate(() => view);
          const button = pages[current.game.currentSeat].locator(`.c4-drop[data-col="${col}"]`);
          await expect(button).toBeEnabled({ timeout: 10000 });
          await button[mobile ? 'tap' : 'click']();
          await expect.poll(() => host.evaluate(() => view.game.moveCount)).toBe(current.game.moveCount + 1);
        }
        await host.mouse.move(0, 0);
        await host.screenshot({ path: path.join(out, `game-${label}.png`), animations: 'disabled' });
        expect(errors).toEqual([]);
        metadata.screenshots.push({ viewport, mobile, roomCode, moves: 6, files: [...['hub', 'lobby', 'game'].map((name) => `${name}-${label}.png`), ...(mobile ? ['hub-games-mobile.png'] : [])] });
      } finally { for (const context of contexts) await context.close(); }
    }
    await fs.writeFile(path.join(out, 'capture-metadata.json'), JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify(metadata, null, 2));
  } finally { await browser.close(); await worker.stop(); }
}
capture().catch((error) => { console.error(error); process.exit(1); });
