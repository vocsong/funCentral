// Screenshot capture for Word Agents UI review (not part of the Playwright suite).
// Real local Worker + WordAgentsRoom Durable Object, real dev-login identities and real
// moves driven through the UI. Nothing is patched; the board shuffle is random.
//   PLAYWRIGHT_CHANNEL=chrome node tests/ui/wordagents-capture.cjs docs/wordagents/screenshots
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');

const out = path.resolve(process.argv[2] || 'wordagents-shots');
const DESKTOP = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const worker = await startWorker(4252);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const contexts = [];
  const touch = new WeakSet();
  const token = async (name) => (await (await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) })).json()).token;
  async function client(name, device, hash = '') {
    const context = await browser.newContext(device);
    contexts.push(context);
    const page = await context.newPage();
    if (device.hasTouch) touch.add(page);
    page.on('pageerror', (error) => console.error(`[${name}] ${error.message}`));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === worker.origin || FONT_HOSTS.includes(url.hostname) ? route.continue() : route.abort();
    });
    const auth = name ? await token(name) : null;
    await page.addInitScript((t) => { if (t) localStorage.setItem('authToken', t); }, auth);
    await page.goto(`${worker.origin}/wordagents/${hash}`);
    return page;
  }
  const shot = async (page, name, fullPage = true) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage, animations: 'disabled' });
    console.log('captured', name);
  };
  const shotAtSize = async (page, viewport, ...images) => {
    const original = page.viewportSize();
    try {
      await page.setViewportSize(viewport);
      for (const image of images) await shot(page, ...image);
    } finally {
      await page.setViewportSize(original);
    }
  };
  const state = (page) => page.evaluate(() => view);
  const tap = (page, locator) => (touch.has(page) ? locator.tap() : locator.click());

  try {
    const alice = await client('Alice Agent', DESKTOP);
    await alice.locator('#btn-create').waitFor();
    await shot(alice, 'desktop-home');
    const phoneHome = await client('Erin Agent', PHONE);
    await phoneHome.locator('#btn-create').waitFor();
    await shot(phoneHome, 'phone-home');

    await alice.click('#btn-create');
    await alice.waitForFunction(() => view?.players?.length === 1);
    const room = (await state(alice)).roomCode;
    const bob = await client('Bob Agent', DESKTOP, `#${room}`);
    const cara = await client('Cara Agent', DESKTOP, `#${room}`);
    const dan = await client('Dan Agent', PHONE, `#${room}`);
    await alice.waitForFunction(() => view?.players?.length === 4);
    await shot(alice, 'desktop-lobby');
    await shot(dan, 'phone-lobby');

    await alice.click('#btn-start');
    const teams = { red: {}, blue: {} };
    for (const page of [alice, bob, cara, dan]) {
      await page.waitForFunction(() => view.you?.role && view.game?.phase === 'clue');
      const { team, role } = (await state(page)).you;
      teams[team][role === 'spymaster' ? 'spy' : 'op'] = page;
    }
    const firstTeam = (await state(alice)).game.turn;
    const order = firstTeam === 'red' ? ['red', 'blue'] : ['blue', 'red'];
    // Each team plays one turn: clue, one correct reveal, a shared mark and a pending selection.
    for (const [turnNo, team] of order.entries()) {
      const { spy, op } = teams[team];
      await spy.waitForFunction(() => view.game.phase === 'clue' && view.you.team === view.game.turn);
      if (turnNo === 0) await shotAtSize(spy, DESKTOP.viewport, ['desktop-spymaster-clue']);
      await spy.fill('#clue-input', turnNo === 0 ? 'Voyage' : 'Garden');
      await spy.click('#count-up');
      await spy.click('#btn-clue');
      await op.waitForFunction(() => view.game.phase === 'guess');
      const own = (await state(spy)).game.cards.flatMap((c, i) => c.color === team && !c.revealed ? [i] : []);
      await tap(op, op.locator(`.wa-card[data-index="${own[0]}"]`));
      await tap(op, op.locator('#btn-reveal'));
      await op.waitForFunction((i) => view.game.cards[i].revealed, own[0]);
      await tap(op, op.locator(`.wa-card[data-index="${own[1]}"]`));
      await tap(op, op.locator('#btn-mark'));
      await op.waitForFunction(() => view.game.marks.length === 1);
      await tap(op, op.locator(`.wa-card[data-index="${own[2]}"]`));
      await op.waitForTimeout(3200); // let event toasts clear
      if (turnNo === 0) {
        await shotAtSize(op, DESKTOP.viewport, ['desktop-operative']);
        await shotAtSize(op, PHONE.viewport, ['phone-operative', false], ['phone-operative-fullpage']);
        await shotAtSize(op, { width: 320, height: 740 }, ['compact-operative-fullpage']);
        await shotAtSize(spy, DESKTOP.viewport, ['desktop-spymaster-guessing']);
        await tap(op, op.locator('#btn-end'));
        await tap(op, op.locator('#confirm-ok'));
      } else {
        const assassin = (await state(spy)).game.cards.findIndex((c) => c.color === 'assassin');
        await tap(op, op.locator(`.wa-card[data-index="${assassin}"]`));
        await tap(op, op.locator('#btn-reveal'));
      }
    }
    await alice.waitForSelector('#modal-over:not(.hidden)');
    await alice.waitForTimeout(600);
    await shot(alice, 'desktop-results', false);
    await dan.waitForSelector('#modal-over:not(.hidden)');
    await shot(dan, 'phone-results', false);
    await alice.click('#btn-over-close');
    await shot(alice, 'desktop-final-board');
    const watcher = await client(null, PHONE, `#${room}`);
    await watcher.waitForFunction(() => !!view?.game);
    await watcher.locator('#btn-over-close').tap();
    await shot(watcher, 'phone-guest-watcher-fullpage');
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    await worker.stop();
  }
})().catch((error) => { console.error(error); process.exit(1); });
